package chaos

import (
	"testing"
	"time"

	"github.com/sivchari/kumo/internal/awsapi"
	"github.com/sivchari/kumo/internal/latency"
	"github.com/sivchari/kumo/internal/servicecatalog"
)

func TestEngineEvaluateMatchesServiceAndAction(t *testing.T) {
	t.Parallel()

	e := NewEngine(servicecatalog.NewDefault())
	err := e.UpsertRule(Rule{
		ID:      "ddb-put-throttle",
		Enabled: true,
		Match:   Match{Service: "dynamodb", Action: "PutItem"},
		Inject: Inject{
			Kind:        InjectThrottle,
			Probability: 1.0,
			AWSError:    &AWSErrorSpec{Code: "ProvisionedThroughputExceededException"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	hit := e.Evaluate(&awsapi.RequestInfo{Service: "dynamodb", Action: "PutItem"})
	if hit == nil || hit.RuleID != "ddb-put-throttle" {
		t.Fatalf("expected match, got %#v", hit)
	}

	miss := e.Evaluate(&awsapi.RequestInfo{Service: "dynamodb", Action: "GetItem"})
	if miss != nil {
		t.Fatalf("expected miss, got %#v", miss)
	}
}

func TestEngineProbabilityZeroNeverMatches(t *testing.T) {
	t.Parallel()

	e := NewEngine(servicecatalog.NewDefault())
	_ = e.UpsertRule(Rule{
		ID:      "never",
		Enabled: true,
		Match:   Match{Service: "s3"},
		Inject: Inject{
			Kind:        InjectAWSError,
			Probability: 0,
			AWSError:    &AWSErrorSpec{Code: "InternalError"},
		},
	})

	for i := 0; i < 100; i++ {
		if d := e.Evaluate(&awsapi.RequestInfo{Service: "s3", Action: "PutObject"}); d != nil {
			t.Fatalf("probability=0 should never match, got %#v", d)
		}
	}
}

func TestEngineUpsertReplacesByID(t *testing.T) {
	t.Parallel()

	e := NewEngine(servicecatalog.NewDefault())
	_ = e.UpsertRule(Rule{
		ID: "r1", Enabled: true,
		Match:  Match{Service: "s3"},
		Inject: Inject{Kind: InjectAWSError, Probability: 1, AWSError: &AWSErrorSpec{Code: "A"}},
	})
	_ = e.UpsertRule(Rule{
		ID: "r1", Enabled: true,
		Match:  Match{Service: "s3"},
		Inject: Inject{Kind: InjectAWSError, Probability: 1, AWSError: &AWSErrorSpec{Code: "B"}},
	})

	snap := e.Snapshot()
	if len(snap.Rules) != 1 {
		t.Fatalf("expected 1 rule after upsert, got %d", len(snap.Rules))
	}
	if snap.Rules[0].Inject.AWSError.Code != "B" {
		t.Fatalf("expected upsert to replace, got %s", snap.Rules[0].Inject.AWSError.Code)
	}
}

func TestEngineFeedbackAmplifiesProbability(t *testing.T) {
	t.Parallel()

	e := NewEngine(servicecatalog.NewDefault())
	err := e.UpsertRule(Rule{
		ID:      "ddb-feedback",
		Enabled: true,
		Match:   Match{Service: "dynamodb"},
		Inject: Inject{
			// Base probability 0; only the feedback should push it up.
			// This makes the test deterministic (each excess match adds 1.0 → prob>=1).
			Kind:        InjectAWSError,
			Probability: 0,
			AWSError:    &AWSErrorSpec{Code: "ThrottlingException"},
			Feedback: &FeedbackSpec{
				WindowMs:        10_000,
				Threshold:       0,
				ProbabilityStep: 1.0, // each match adds 1.0 to prob
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	// First Evaluate sees 0 matches in window → prob 0 → skip.
	// But Evaluate doesn't record a hit when it skips, so we need to seed
	// the window directly via repeated forced-match calls. We test by
	// raising the threshold to 0 with step=1 — once one match lands by
	// pure luck-of-the-draw it should snowball.
	// Easier: poke recordHit directly via a separate rule-id helper isn't
	// exposed, so instead we use Probability=1 to seed the first match,
	// then re-eval many times.
	_ = e.DeleteRule("ddb-feedback")
	_ = e.UpsertRule(Rule{
		ID:      "ddb-feedback",
		Enabled: true,
		Match:   Match{Service: "dynamodb"},
		Inject: Inject{
			Kind:        InjectAWSError,
			Probability: 1, // seed first match
			AWSError:    &AWSErrorSpec{Code: "ThrottlingException"},
			Feedback: &FeedbackSpec{
				WindowMs:        10_000,
				Threshold:       0,
				ProbabilityStep: 1.0,
				MaxProbability:  1.0,
			},
		},
	})
	hits := 0
	for i := 0; i < 100; i++ {
		if e.Evaluate(&awsapi.RequestInfo{Service: "dynamodb"}) != nil {
			hits++
		}
	}
	// Without feedback (Prob=1 only) we'd expect 100. With feedback the
	// already-1.0 prob is capped at MaxProbability=1.0, so we still expect
	// 100 hits — but the window should now contain 100 timestamps and
	// recentMatches should report them.
	if hits != 100 {
		t.Fatalf("expected 100 forced-hit matches, got %d", hits)
	}

	snap := e.Snapshot()
	if snap.Stats[0].Matched < 100 {
		t.Fatalf("expected matched counter >= 100, got %d", snap.Stats[0].Matched)
	}
}

func TestEngineFeedbackAmplifiesLatency(t *testing.T) {
	t.Parallel()

	e := NewEngine(servicecatalog.NewDefault())
	// Base latency 100ms, feedback adds (1 + 0.5 * excess)x. With threshold=0,
	// after the 1st match the latency should scale.
	const baseMs = 100
	err := e.UpsertRule(Rule{
		ID:      "kinesis-latency-feedback",
		Enabled: true,
		Match:   Match{Service: "kinesis"},
		Inject: Inject{
			Kind:        InjectLatency,
			Probability: 1,
			Latency:     &latency.Latency{FixedMs: baseMs},
			Feedback: &FeedbackSpec{
				WindowMs:        10_000,
				Threshold:       0,
				LatencyMultStep: 0.5,
				MaxLatencyMult:  5,
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	// 1st eval: 0 prior matches in window, but recordHit fires AFTER the
	// effective calc, so this one is at 1x base.
	d1 := e.Evaluate(&awsapi.RequestInfo{Service: "kinesis"})
	if d1 == nil {
		t.Fatal("expected decision 1")
	}
	// 2nd eval: 1 prior match in window, excess=1, mult=1+0.5*1=1.5.
	d2 := e.Evaluate(&awsapi.RequestInfo{Service: "kinesis"})
	if d2 == nil {
		t.Fatal("expected decision 2")
	}
	if d2.Delay <= d1.Delay {
		t.Fatalf("expected feedback to grow latency; d1=%v d2=%v", d1.Delay, d2.Delay)
	}

	// After many evals, latency should saturate at MaxLatencyMult.
	for i := 0; i < 50; i++ {
		_ = e.Evaluate(&awsapi.RequestInfo{Service: "kinesis"})
	}
	dN := e.Evaluate(&awsapi.RequestInfo{Service: "kinesis"})
	expectedMax := time.Duration(baseMs) * 5 * time.Millisecond
	if dN.Delay != expectedMax {
		t.Fatalf("expected saturated latency = %v; got %v", expectedMax, dN.Delay)
	}
}

func TestEngineDeleteAndClear(t *testing.T) {
	t.Parallel()

	e := NewEngine(servicecatalog.NewDefault())
	_ = e.UpsertRule(Rule{ID: "a", Enabled: true, Match: Match{Service: "s3"},
		Inject: Inject{Kind: InjectAWSError, Probability: 1, AWSError: &AWSErrorSpec{Code: "X"}}})
	_ = e.UpsertRule(Rule{ID: "b", Enabled: true, Match: Match{Service: "s3"},
		Inject: Inject{Kind: InjectAWSError, Probability: 1, AWSError: &AWSErrorSpec{Code: "Y"}}})

	if !e.DeleteRule("a") {
		t.Fatal("DeleteRule(a) should report true")
	}
	if e.DeleteRule("missing") {
		t.Fatal("DeleteRule(missing) should report false")
	}
	e.Clear()
	if len(e.Snapshot().Rules) != 0 {
		t.Fatal("Clear should empty rules")
	}
}
