package chaos

import (
	"math/rand/v2"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sivchari/kumo/internal/awsapi"
	"github.com/sivchari/kumo/internal/servicecatalog"
)

// Engine holds runtime-mutable chaos rules and evaluates them per request.
//
// Concurrency: rule mutation is rare (drill setup/teardown), evaluation is
// hot. We take a read lock on Evaluate and a write lock on mutation.
type Engine struct {
	mu      sync.RWMutex
	catalog *servicecatalog.Catalog
	rules   []ruleEntry
	rng     *rand.Rand
}

type ruleEntry struct {
	rule      Rule
	matched   atomic.Int64
	skipped   atomic.Int64
	lastApply atomic.Pointer[time.Time]
}

// NewEngine returns an Engine with no rules.
func NewEngine(catalog *servicecatalog.Catalog) *Engine {
	if catalog == nil {
		catalog = servicecatalog.NewDefault()
	}
	return &Engine{
		catalog: catalog,
		//nolint:gosec // Non-cryptographic; only used for probability sampling.
		rng: rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), 0)),
	}
}

// UpsertRule adds or replaces a rule by ID.
func (e *Engine) UpsertRule(r Rule) error {
	if err := r.validate(); err != nil {
		return err
	}
	r.Match.Service = e.catalog.MustNormalize(r.Match.Service)

	e.mu.Lock()
	defer e.mu.Unlock()
	for i := range e.rules {
		if e.rules[i].rule.ID == r.ID {
			e.rules[i].rule = r
			return nil
		}
	}
	e.rules = append(e.rules, ruleEntry{rule: r})
	return nil
}

// DeleteRule removes a rule by ID. Returns true if it existed.
func (e *Engine) DeleteRule(id string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	for i := range e.rules {
		if e.rules[i].rule.ID == id {
			e.rules = append(e.rules[:i], e.rules[i+1:]...)
			return true
		}
	}
	return false
}

// Clear removes all rules.
func (e *Engine) Clear() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.rules = nil
}

// Snapshot returns the current rules + per-rule stats. Suitable for the
// GET /kumo/chaos/rules admin response.
func (e *Engine) Snapshot() Snapshot {
	e.mu.RLock()
	defer e.mu.RUnlock()
	out := Snapshot{
		Rules: make([]Rule, len(e.rules)),
		Stats: make([]Stats, len(e.rules)),
	}
	for i := range e.rules {
		out.Rules[i] = e.rules[i].rule
		s := Stats{
			RuleID:  e.rules[i].rule.ID,
			Matched: e.rules[i].matched.Load(),
			Skipped: e.rules[i].skipped.Load(),
		}
		if last := e.rules[i].lastApply.Load(); last != nil {
			s.LastApply = last.UTC().Format(time.RFC3339)
		}
		out.Stats[i] = s
	}
	return out
}

// Evaluate returns the first matching decision for info, or nil for pass-through.
//
// Returning nil is the hot path (no chaos). Callers should not allocate until
// a non-nil decision is returned.
func (e *Engine) Evaluate(info *awsapi.RequestInfo) *Decision {
	if info == nil {
		return nil
	}

	e.mu.RLock()
	defer e.mu.RUnlock()

	if len(e.rules) == 0 {
		return nil
	}

	normalized := *info
	normalized.Service = e.catalog.MustNormalize(normalized.Service)

	for i := range e.rules {
		entry := &e.rules[i]
		if !entry.rule.Enabled {
			continue
		}
		if !matchRule(&entry.rule.Match, &normalized) {
			continue
		}
		// Probability gate. 0 means "never" by convention (allows disabled-style),
		// while 1 means "always". Anything in between rolls per-request.
		if entry.rule.Inject.Probability < 1 {
			if e.rng.Float64() >= entry.rule.Inject.Probability {
				entry.skipped.Add(1)
				continue
			}
		}
		entry.matched.Add(1)
		now := time.Now()
		entry.lastApply.Store(&now)

		dec := &Decision{RuleID: entry.rule.ID, Inject: entry.rule.Inject}
		if entry.rule.Inject.Kind == InjectLatency && entry.rule.Inject.Latency != nil {
			dec.Delay = entry.rule.Inject.Latency.DurationAt(e.rng.Float64())
		}
		return dec
	}
	return nil
}

// --- small helpers; intentionally duplicated from latency to keep packages
// --- independent and avoid an internal cyclic-import risk down the line.

func sameToken(a, b string) bool {
	return compactToken(a) == compactToken(b)
}

func compactToken(s string) string {
	s = strings.TrimSpace(strings.ToLower(s))
	s = strings.ReplaceAll(s, "-", "")
	s = strings.ReplaceAll(s, "_", "")
	s = strings.ReplaceAll(s, ".", "")
	return s
}

func equalFold(a, b string) bool {
	return strings.EqualFold(a, b)
}
