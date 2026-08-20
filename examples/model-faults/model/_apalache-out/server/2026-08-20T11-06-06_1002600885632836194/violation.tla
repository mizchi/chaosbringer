---------------------------- MODULE counterexample ----------------------------

EXTENDS checkout

(* Constant initialization state *)
ConstInit == TRUE

(* Initial state [_transition(0)] *)
State0 ==
  log = <<>>
    /\ opState
      = SetAsFun({ <<"cart", "unstarted">>, <<"shipping", "unstarted">> })
    /\ ui = "idle"
    /\ unhandled = FALSE

(* State1 [_transition(1)] *)
State1 ==
  log = <<[kind |-> "start", op |-> "-"]>>
    /\ opState = SetAsFun({ <<"cart", "pending">>, <<"shipping", "pending">> })
    /\ ui = "loading"
    /\ unhandled = FALSE

(* State2 [_transition(4)] *)
State2 ==
  log
      = <<
        [kind |-> "start", op |-> "-"], [kind |-> "rejectBody",
          op |-> "shipping"]
      >>
    /\ opState
      = SetAsFun({ <<"cart", "pending">>, <<"shipping", "bodyRejected">> })
    /\ ui = "error"
    /\ unhandled = FALSE

(* State3 [_transition(2)] *)
State3 ==
  log
      = <<
        [kind |-> "start", op |-> "-"], [kind |-> "rejectBody",
          op |-> "shipping"], [kind |-> "fulfil", op |-> "cart"]
      >>
    /\ opState
      = SetAsFun({ <<"cart", "fulfilled">>, <<"shipping", "bodyRejected">> })
    /\ ui = "error"
    /\ unhandled = FALSE

(* The following formula holds true in the last state and violates the invariant *)
InvariantViolation ==
  opState["cart"] = "fulfilled" /\ opState["shipping"] = "bodyRejected"

================================================================================
(* Created by Apalache on Thu Aug 20 11:06:11 UTC 2026 *)
(* https://github.com/apalache-mc/apalache *)
