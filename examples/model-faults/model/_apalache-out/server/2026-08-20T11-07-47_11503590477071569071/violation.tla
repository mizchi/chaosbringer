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

(* State2 [_transition(5)] *)
State2 ==
  log = <<[kind |-> "start", op |-> "-"], [kind |-> "hang", op |-> "shipping"]>>
    /\ opState = SetAsFun({ <<"cart", "pending">>, <<"shipping", "hung">> })
    /\ ui = "error"
    /\ unhandled = FALSE

(* State3 [_transition(4)] *)
State3 ==
  log
      = <<
        [kind |-> "start", op |-> "-"], [kind |-> "hang", op |-> "shipping"], [kind |->
            "rejectBody",
          op |-> "cart"]
      >>
    /\ opState
      = SetAsFun({ <<"cart", "bodyRejected">>, <<"shipping", "hung">> })
    /\ ui = "error"
    /\ unhandled = FALSE

(* The following formula holds true in the last state and violates the invariant *)
InvariantViolation ==
  opState["cart"] = "bodyRejected" /\ opState["shipping"] = "hung"

================================================================================
(* Created by Apalache on Thu Aug 20 11:07:53 UTC 2026 *)
(* https://github.com/apalache-mc/apalache *)
