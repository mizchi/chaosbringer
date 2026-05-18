package chaos

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/sivchari/kumo/internal/awsapi"
)

// WriteAWSError writes a protocol-appropriate AWS error response for spec.
// The protocol is read from info.Protocol (set by router.requestInfo) and
// determines the envelope: JSON 1.0/1.1, Query (XML), REST (XML), or CBOR.
//
// We deliberately keep this small. Drills target a few well-known error
// codes (throttling, server errors); rare/exotic AWS shapes can be added
// when a drill needs them, not pre-emptively.
func WriteAWSError(w http.ResponseWriter, info *awsapi.RequestInfo, spec *AWSErrorSpec) {
	status := spec.HTTPStatus
	if status == 0 {
		status = defaultStatusFor(spec.Code)
	}
	message := spec.Message
	if message == "" {
		message = fmt.Sprintf("kumo chaos: synthetic %s", spec.Code)
	}

	switch info.Protocol {
	case "json", "cbor":
		// AWS JSON 1.0/1.1 (and CBOR clients accept the same JSON error envelope).
		w.Header().Set("Content-Type", "application/x-amz-json-1.0")
		w.Header().Set("x-amzn-ErrorType", spec.Code)
		w.WriteHeader(status)
		body, _ := json.Marshal(map[string]string{
			"__type":  jsonErrorType(info.Service, spec.Code),
			"message": message,
			"Message": message,
		})
		_, _ = w.Write(body)
	case "query":
		w.Header().Set("Content-Type", "text/xml")
		w.WriteHeader(status)
		fmt.Fprintf(w,
			`<?xml version="1.0"?><ErrorResponse><Error><Type>Sender</Type><Code>%s</Code><Message>%s</Message></Error><RequestId>kumo-chaos</RequestId></ErrorResponse>`,
			spec.Code, escapeXML(message))
	case "rest":
		// REST/S3-style XML.
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(status)
		fmt.Fprintf(w,
			`<?xml version="1.0" encoding="UTF-8"?><Error><Code>%s</Code><Message>%s</Message><RequestId>kumo-chaos</RequestId></Error>`,
			spec.Code, escapeXML(message))
	default:
		// Fallback to JSON 1.0; better to return a parseable error than to
		// hang the client with an empty body.
		w.Header().Set("Content-Type", "application/x-amz-json-1.0")
		w.WriteHeader(status)
		body, _ := json.Marshal(map[string]string{"__type": spec.Code, "message": message})
		_, _ = w.Write(body)
	}
}

// defaultStatusFor returns the HTTP status AWS uses for well-known error codes.
// Unknown codes default to 400; chaos drills can override via HTTPStatus.
func defaultStatusFor(code string) int {
	switch code {
	case "ProvisionedThroughputExceededException",
		"ThrottlingException",
		"Throttling",
		"TooManyRequestsException",
		"RequestLimitExceeded",
		"SlowDown":
		return 400
	case "InternalServerError", "InternalFailure", "ServiceUnavailable":
		return 500
	case "ServiceUnavailableException":
		return 503
	default:
		return 400
	}
}

// jsonErrorType builds the qualified __type string AWS JSON protocols expect.
// Service-specific prefixes are best-effort; SDKs parse the suffix after '#'.
func jsonErrorType(service, code string) string {
	prefixes := map[string]string{
		"dynamodb":       "com.amazonaws.dynamodb.v20120810",
		"kinesis":        "com.amazonaws.kinesis.v20131202",
		"sqs":            "com.amazonaws.sqs",
		"lambda":         "com.amazonaws.lambda",
		"cloudwatchlogs": "com.amazonaws.logs",
	}
	if prefix, ok := prefixes[compactToken(service)]; ok {
		return prefix + "#" + code
	}
	return code
}

// WriteSilentSuccess emits a protocol-correct, content-empty success
// response for the matched AWS request. Used by Byzantine chaos rules
// that return "ok" without invoking the real handler — the call looks
// successful but no data is actually persisted.
//
// We do NOT try to construct a fully-populated response body. For
// PutItem / PutRecord / PutObject etc. the SDK is happy with an empty
// 200; for read-shaped commands (GetItem / Query / Scan / GetObject)
// the SDK accepts an empty 200 and surfaces it as "not found" or
// "empty result," which is itself a Byzantine pattern (the caller
// gets back a valid response that doesn't match reality).
func WriteSilentSuccess(w http.ResponseWriter, info *awsapi.RequestInfo) {
	switch info.Protocol {
	case "json", "cbor":
		w.Header().Set("Content-Type", "application/x-amz-json-1.0")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	case "query":
		w.Header().Set("Content-Type", "text/xml")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w,
			`<?xml version="1.0"?><Response><ResponseMetadata><RequestId>kumo-byzantine</RequestId></ResponseMetadata></Response>`,
		)
	case "rest":
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(http.StatusOK)
	default:
		w.Header().Set("Content-Type", "application/x-amz-json-1.0")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}
}

func escapeXML(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	return s
}
