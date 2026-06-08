from uagents import Model


class SharedAgentState(Model):
    """
    Shared communication contract between the orchestrator and all worker agents.

    The orchestrator manages this state and forwards it to the appropriate worker.
    The worker runs its workflow, writes its output to `result`, and sends the state
    back.

    Attributes:
        chat_session_id: Identifies the originating chat session.
        query: The user's request.
        user_sender_address: ASI:One address of the original user, so the orchestrator
            can relay the final response back.
        result: Written by the worker once its workflow completes. Empty until then.
    """

    chat_session_id: str
    query: str
    user_sender_address: str
    result: str = ""
