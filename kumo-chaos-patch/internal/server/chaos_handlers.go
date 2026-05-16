package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/sivchari/kumo/internal/chaos"
)

// registerChaosEndpoints wires /kumo/chaos/* admin endpoints into the router.
//
// These are intentionally enabled only when SetChaosEngine has been called —
// the default kumo binary does not expose chaos endpoints unless wired by the
// owner of the kumo process (in our case, the example orchestrator).
func (s *Server) registerChaosEndpoints() {
	s.router.HandleFunc(http.MethodPost, "/kumo/chaos/rules", s.chaosUpsertRule)
	s.router.HandleFunc(http.MethodGet, "/kumo/chaos/rules", s.chaosListRules)
	s.router.HandleFunc(http.MethodDelete, "/kumo/chaos/rules", s.chaosClearRules)
	s.router.HandleFunc(http.MethodDelete, "/kumo/chaos/rules/{id}", s.chaosDeleteRule)
	s.router.HandleFunc(http.MethodGet, "/kumo/chaos/stats", s.chaosStats)
}

func (s *Server) chaosUpsertRule(w http.ResponseWriter, r *http.Request) {
	if s.chaosEngine == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "chaos engine not enabled"})
		return
	}
	var rule chaos.Rule
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&rule); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err := s.chaosEngine.UpsertRule(rule); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": rule.ID, "status": "installed"})
}

func (s *Server) chaosListRules(w http.ResponseWriter, _ *http.Request) {
	if s.chaosEngine == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "chaos engine not enabled"})
		return
	}
	writeJSON(w, http.StatusOK, s.chaosEngine.Snapshot())
}

func (s *Server) chaosClearRules(w http.ResponseWriter, _ *http.Request) {
	if s.chaosEngine == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "chaos engine not enabled"})
		return
	}
	s.chaosEngine.Clear()
	writeJSON(w, http.StatusOK, map[string]string{"status": "cleared"})
}

func (s *Server) chaosDeleteRule(w http.ResponseWriter, r *http.Request) {
	if s.chaosEngine == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "chaos engine not enabled"})
		return
	}
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "rule id required"})
		return
	}
	if !s.chaosEngine.DeleteRule(id) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "rule not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted", "id": id})
}

func (s *Server) chaosStats(w http.ResponseWriter, _ *http.Request) {
	if s.chaosEngine == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "chaos engine not enabled"})
		return
	}
	writeJSON(w, http.StatusOK, s.chaosEngine.Snapshot().Stats)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil && !errors.Is(err, http.ErrHandlerTimeout) {
		// best-effort; nothing more to do once headers are out.
		_ = err
	}
}
