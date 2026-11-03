#!/bin/bash
# pwndbg GDB wrapper — loads pwndbg if available, falls back to vanilla GDB
export PWNDBG_NO_AUTOUPDATE="${PWNDBG_NO_AUTOUPDATE:-1}"

if [ -f /opt/pwndbg/gdbinit.py ]; then
  exec gdb -q -ex "source /opt/pwndbg/gdbinit.py" "$@"
fi

exec gdb -q "$@"
