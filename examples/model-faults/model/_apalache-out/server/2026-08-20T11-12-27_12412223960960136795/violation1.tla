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

(* State2 [_transition(2)] *)
State2 ==
  log
      = <<
        [kind |-> "start", op |-> "-"], [kind |-> "fulfil", op |-> "shipping"]
      >>
    /\ opState
      = SetAsFun({ <<"cart", "pending">>, <<"shipping", "fulfilled">> })
    /\ ui = "loading"
    /\ unhandled = FALSE

(* State3 [_transition(2)] *)
State3 ==
  log
      = <<
        [kind |-> "start", op |-> "-"], [kind |-> "fulfil", op |-> "shipping"], [kind |->
            "fulfil",
          op |-> "cart"]
      >>
    /\ opState
      = SetAsFun({ <<"cart", "fulfilled">>, <<"shipping", "fulfilled">> })
    /\ ui = "ready"
    /\ unhandled = FALSE

(* The following formula holds true in the last state and violates the invariant *)
InvariantViolation ==
  opState["cart"] = "fulfilled" /\ opState["shipping"] = "fulfilled"

================================================================================
(* Created by Apalache on Thu Aug 20 11:12:32 UTC 2026 *)
(* https://github.com/apalache-mc/apalache *)
