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
  log = <<[kind |-> "start", op |-> "-"], [kind |-> "abort", op |-> "cart"]>>
    /\ opState = SetAsFun({ <<"cart", "aborted">>, <<"shipping", "pending">> })
    /\ ui = "idle"
    /\ unhandled = FALSE

(* State3 [_transition(3)] *)
State3 ==
  log
      = <<
        [kind |-> "start", op |-> "-"], [kind |-> "abort", op |-> "cart"], [kind |->
            "reject",
          op |-> "shipping"]
      >>
    /\ opState = SetAsFun({ <<"cart", "aborted">>, <<"shipping", "rejected">> })
    /\ ui = "idle"
    /\ unhandled = FALSE

(* The following formula holds true in the last state and violates the invariant *)
InvariantViolation ==
  opState["cart"] = "aborted" /\ opState["shipping"] = "rejected"

================================================================================
(* Created by Apalache on Thu Aug 20 11:09:05 UTC 2026 *)
(* https://github.com/apalache-mc/apalache *)
