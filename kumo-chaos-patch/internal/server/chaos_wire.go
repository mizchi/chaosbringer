package server

import (
	"net/http"
	"time"

	"github.com/sivchari/kumo/internal/chaos"
)

// This file is an additive patch over the PR #667 router. The exported
// surface is small and intentionally optional — kumo without chaos wired
// behaves identically.
//
// To apply:
//   1) Add field `chaosEngine *chaos.Engine` to Server struct in server.go
//   2) In server.New(), if cfg.ChaosEnabled, call srv.SetChaosEngine(...)
//      and srv.registerChaosEndpoints()
//   3) Inside wrapHandler() (router.go), after the latency decision is
//      consumed, call r.evaluateChaos(&info, wrapped, req); if it returns
//      true the request was short-circuited and the user handler must be
//      skipped.

// SetChaosEngine attaches a chaos engine to the server and exposes admin
// endpoints. Idempotent.
func (s *Server) SetChaosEngine(e *chaos.Engine) {
	s.chaosEngine = e
	s.router.SetChaosEngine(e)
	s.registerChaosEndpoints()
}

// SetChaosEngine on Router lets the wrapHandler hook reach the engine
// without crossing package boundaries on every request.
func (r *Router) SetChaosEngine(e *chaos.Engine) {
	r.chaosEngine = e
}

// evaluateChaos applies a chaos decision. Returns true if the request was
// handled (caller must NOT invoke the user handler).
//
// Semantics:
//   - "latency": sleep, then fall through to the user handler (return false).
//     This composes with PR #667 latency: chaos latency is additive.
//   - "disconnect": flush nothing, hijack the connection and close it.
//   - "awsError" / "throttle": write the protocol-appropriate error envelope.
func (r *Router) evaluateChaos(info *requestInfo, w http.ResponseWriter, req *http.Request) bool {
	if r.chaosEngine == nil || info.isControl {
		return false
	}
	dec := r.chaosEngine.Evaluate(&info.RequestInfo)
	if dec == nil {
		return false
	}

	switch dec.Inject.Kind {
	case chaos.InjectLatency:
		if dec.Delay > 0 {
			t := time.NewTimer(dec.Delay)
			select {
			case <-t.C:
			case <-req.Context().Done():
				t.Stop()
			}
		}
		return false

	case chaos.InjectDisconnect:
		if dec.Inject.Disconnect != nil && dec.Inject.Disconnect.AfterMs > 0 {
			select {
			case <-time.After(time.Duration(dec.Inject.Disconnect.AfterMs) * time.Millisecond):
			case <-req.Context().Done():
			}
		}
		// Best-effort tear-down. We can't truly send a TCP RST from the Go
		// stdlib http server, but Hijack() lets us close without writing
		// a response, which the client sees as an unexpected EOF — the
		// behavior most SDK retry loops actually need to exercise.
		if hj, ok := w.(http.Hijacker); ok {
			if conn, _, err := hj.Hijack(); err == nil {
				_ = conn.Close()
				return true
			}
		}
		// Fallback: send 502 so callers don't hang forever.
		w.WriteHeader(http.StatusBadGateway)
		return true

	case chaos.InjectAWSError, chaos.InjectThrottle:
		if dec.Inject.AWSError != nil {
			chaos.WriteAWSError(w, &info.RequestInfo, dec.Inject.AWSError)
		} else {
			w.WriteHeader(http.StatusInternalServerError)
		}
		return true
	}
	return false
}
