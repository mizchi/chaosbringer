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

(* State2 [_transition(6)] *)
State2 ==
  log
      = <<
        [kind |-> "start", op |-> "-"], [kind |-> "abort", op |-> "shipping"]
      >>
    /\ opState = SetAsFun({ <<"cart", "pending">>, <<"shipping", "aborted">> })
    /\ ui = "idle"
    /\ unhandled = FALSE

(* State3 [_transition(5)] *)
State3 ==
  log
      = <<
        [kind |-> "start", op |-> "-"], [kind |-> "abort", op |-> "shipping"], [kind |->
            "hang",
          op |-> "cart"]
      >>
    /\ opState = SetAsFun({ <<"cart", "hung">>, <<"shipping", "aborted">> })
    /\ ui = "idle"
    /\ unhandled = FALSE

(* The following formula holds true in the last state and violates the invariant *)
InvariantViolation ==
  opState["cart"] = "hung" /\ opState["shipping"] = "aborted"

================================================================================
(* Created by Apalache on Thu Aug 20 11:08:47 UTC 2026 *)
(* https://github.com/apalache-mc/apalache *)
