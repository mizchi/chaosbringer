// Package chaos provides runtime-controllable fault injection for kumo.
//
// Unlike the latency package (PR #667), chaos rules are mutable at runtime via
// /kumo/chaos/* admin endpoints. A drill installs rules, observes impact, and
// removes them — the engine itself holds no policy.
package chaos

import (
	"errors"
	"time"

	"github.com/sivchari/kumo/internal/awsapi"
	"github.com/sivchari/kumo/internal/latency"
)

var (
	errRuleIDRequired    = errors.New("chaos rule id is required")
	errInjectRequired    = errors.New("chaos rule inject is required")
	errUnknownInjectKind = errors.New("chaos rule inject.kind is unknown")
	errProbabilityRange  = errors.New("chaos rule probability must be in [0, 1]")
)

// Rule is a single runtime fault-injection rule.
type Rule struct {
	ID      string `json:"id"`
	Enabled bool   `json:"enabled"`
	Match   Match  `json:"match"`
	Inject  Inject `json:"inject"`
}

// Match reuses the same matcher contract as latency rules (#667) so callers
// can move rules between latency and chaos with no shape change.
type Match struct {
	Service  string `json:"service,omitempty"`
	Action   string `json:"action,omitempty"`
	Method   string `json:"method,omitempty"`
	Path     string `json:"path,omitempty"`
	Pattern  string `json:"pattern,omitempty"`
	Resource string `json:"resource,omitempty"`
}

// Inject describes what fault to apply when a rule matches.
//
// Exactly one of Kind's payloads is honored. We keep them in one struct
// (rather than oneof) because JSON is the wire format and a flat shape is
// easier for SDK clients to construct from drill code.
type Inject struct {
	Kind        InjectKind `json:"kind"`
	Probability float64    `json:"probability"`

	// Kind == "latency"
	Latency *latency.Latency `json:"latency,omitempty"`

	// Kind == "disconnect"
	// Style is "hangup" (close without writing) or "reset" (TCP RST emulated).
	Disconnect *DisconnectSpec `json:"disconnect,omitempty"`

	// Kind == "awsError" | "throttle"
	// AWSError holds the canonical error code; the responder picks the
	// right protocol envelope based on the matched RequestInfo.Protocol.
	AWSError *AWSErrorSpec `json:"awsError,omitempty"`

	// Feedback enables load-amplification: as more requests match this
	// rule per unit time, the effective probability and latency grow.
	// Reproduces the 2015 DynamoDB metadata-overload feedback loop where
	// retry storms made the backend slower, throwing more errors.
	// Nil means no feedback (fixed probability + fixed latency profile).
	Feedback *FeedbackSpec `json:"feedback,omitempty"`
}

// FeedbackSpec scales a rule's probability and latency by recent match rate.
//
// The engine keeps a per-rule sliding window of match timestamps. On each
// evaluation, it counts matches in the last WindowMs. If that count exceeds
// Threshold, the rule's effective probability is increased by
// `ProbabilityStep * (count - Threshold)` (capped at MaxProbability), and
// latency is multiplied by `1 + LatencyMultStep * (count - Threshold)`
// (capped at MaxLatencyMult).
//
// Default values (when fields are zero): WindowMs=1000, MaxProbability=1.0,
// MaxLatencyMult=10.0. Threshold and Steps default to 0 (no effect — the
// caller must set at least one of ProbabilityStep / LatencyMultStep for
// feedback to do anything).
type FeedbackSpec struct {
	WindowMs        int     `json:"windowMs,omitempty"`
	Threshold       int     `json:"threshold,omitempty"`
	ProbabilityStep float64 `json:"probabilityStep,omitempty"`
	LatencyMultStep float64 `json:"latencyMultStep,omitempty"`
	MaxProbability  float64 `json:"maxProbability,omitempty"`
	MaxLatencyMult  float64 `json:"maxLatencyMult,omitempty"`
}

func (f *FeedbackSpec) windowDuration() time.Duration {
	if f.WindowMs <= 0 {
		return time.Second
	}
	return time.Duration(f.WindowMs) * time.Millisecond
}

func (f *FeedbackSpec) maxProbability() float64 {
	if f.MaxProbability <= 0 {
		return 1.0
	}
	return f.MaxProbability
}

func (f *FeedbackSpec) maxLatencyMult() float64 {
	if f.MaxLatencyMult <= 0 {
		return 10.0
	}
	return f.MaxLatencyMult
}

// InjectKind enumerates supported fault types.
type InjectKind string

const (
	InjectLatency       InjectKind = "latency"
	InjectDisconnect    InjectKind = "disconnect"
	InjectAWSError      InjectKind = "awsError"
	InjectThrottle      InjectKind = "throttle"
	InjectSilentSuccess InjectKind = "silentSuccess"
)

// DisconnectSpec describes a connection tear-down.
type DisconnectSpec struct {
	Style   string `json:"style,omitempty"`   // "hangup" | "reset"
	AfterMs int    `json:"afterMs,omitempty"` // delay before tearing down, 0 = immediate
}

// AWSErrorSpec describes a synthetic AWS error response.
//
// Code is the AWS error code (e.g. "ProvisionedThroughputExceededException").
// HTTPStatus defaults to 400 for client-class throttling errors and 500 for
// server-class errors when zero; callers can override.
// Message defaults to a synthetic explanation if empty.
type AWSErrorSpec struct {
	Code       string `json:"code"`
	HTTPStatus int    `json:"httpStatus,omitempty"`
	Message    string `json:"message,omitempty"`
}

// Decision is what the engine returned for one request.
type Decision struct {
	RuleID string
	Inject Inject
	Delay  time.Duration // resolved when Kind == latency
}

// Stats is per-rule injection counters returned by GET /kumo/chaos/stats.
type Stats struct {
	RuleID    string `json:"ruleId"`
	Matched   int64  `json:"matched"`             // matched + probability won
	Skipped   int64  `json:"skipped"`             // matched but probability lost
	LastApply string `json:"lastApply,omitempty"` // RFC3339
	// RecentTraces is a length-capped ring buffer of W3C traceparent
	// header values (or any X-Kumo-Trace value) seen on requests this
	// rule matched. Lets a scoring step join the chaosbringer journey's
	// per-iteration trace IDs with which chaos rules actually fired.
	// Population requires the wire layer to forward the inbound trace
	// header; without that, this stays empty.
	RecentTraces []string `json:"recentTraces,omitempty"`
}

// Snapshot is the response shape for GET /kumo/chaos/rules.
type Snapshot struct {
	Rules []Rule  `json:"rules"`
	Stats []Stats `json:"stats"`
}

// validate enforces invariants before a rule is admitted to the engine.
func (r *Rule) validate() error {
	if r.ID == "" {
		return errRuleIDRequired
	}
	if r.Inject.Probability < 0 || r.Inject.Probability > 1 {
		return errProbabilityRange
	}
	switch r.Inject.Kind {
	case InjectLatency:
		if r.Inject.Latency == nil {
			return errInjectRequired
		}
		return r.Inject.Latency.Validate()
	case InjectDisconnect:
		if r.Inject.Disconnect == nil {
			return errInjectRequired
		}
	case InjectAWSError, InjectThrottle:
		if r.Inject.AWSError == nil || r.Inject.AWSError.Code == "" {
			return errInjectRequired
		}
	case InjectSilentSuccess:
		// Byzantine: no payload required — returns a protocol-default
		// success response with empty body. The simulated AWS service
		// says "ok" but the real handler is never invoked, so any data
		// the call was supposed to persist quietly vanishes.
	default:
		return errUnknownInjectKind
	}
	return nil
}

// requestInfoMatcher mirrors the latency package's matcher so chaos and
// latency share semantics. Kept private — tests cover it indirectly.
func matchRule(m *Match, info *awsapi.RequestInfo) bool {
	if m.Service != "" && !sameToken(m.Service, info.Service) {
		return false
	}
	if m.Action != "" && !sameToken(m.Action, info.Action) {
		return false
	}
	if m.Method != "" && !equalFold(m.Method, info.Method) {
		return false
	}
	if m.Path != "" && m.Path != info.Path {
		return false
	}
	if m.Pattern != "" && m.Pattern != info.Pattern {
		return false
	}
	if m.Resource != "" && m.Resource != info.Resource {
		return false
	}
	return true
}
