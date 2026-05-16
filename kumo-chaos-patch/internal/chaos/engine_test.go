package chaos

import (
	"testing"

	"github.com/sivchari/kumo/internal/awsapi"
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
