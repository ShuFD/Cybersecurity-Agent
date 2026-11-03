# Executor timeout analysis

`rpgo` replacement and `skilift` diagnostic both report typed `executor_timeout` with zero parent turns and zero parent tool calls. Their retained parent events contain no worker tool execution, so the evidence supports **startup/settlement timeout**, not an active task-tool timeout. A model-stream timeout cannot be proven because no child `assistant_message_start` is durably visible.

`stfu` ended by controller wall-clock timeout with no typed Planning stage in the retained parent artifact; classify as `PLANNING_RUNTIME_TIMEOUT_UNKNOWN`, not as an Executor active-task timeout.

Required next observability (proposal only): persist child-session start, first assistant output, task lease/start, abort, recovery, and settlement boundaries. Keep existing timeout values unchanged.
