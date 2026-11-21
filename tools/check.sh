#!/bin/bash
# usage: check.sh <N> [vitest file or dir ...]
# Ships the working tree of /home/wcc/work/pr3283/w<N> (committed + uncommitted, vs base 41a46042b) to gpu
# /tmp/cxrma/w<N>, then runs typecheck, lint:source and the given vitest files there. Output: last lines of each step.
set -uo pipefail
N=$1; shift
BASE=41a46042b
W=/home/wcc/work/pr3283/w$N
cd "$W" || exit 1
git add -A -N . 2>/dev/null
git diff --binary $BASE > /tmp/rma-w$N.patch
SSH="ssh -F $HOME/YellowPage/ssh_config gpu-via-juma3"
scp -q -F ~/YellowPage/ssh_config /tmp/rma-w$N.patch gpu-via-juma3:/tmp/cxrma/w$N.patch || exit 1
TESTS="$*"
timeout 1500 $SSH "chown cxrma /tmp/cxrma/w$N.patch; /root/work/handoff/linux-rig/cx-enter.sh cxrma bash -c '
cd /tmp/cxrma/w$N && git checkout -q -f $BASE && git clean -fdq -e node_modules && { [ ! -s /tmp/cxrma/w$N.patch ] || git apply --index --whitespace=nowarn /tmp/cxrma/w$N.patch; } || { echo PATCH FAILED; exit 1; }
export CI=1
echo \"== typecheck\"; timeout 15m pnpm -s typecheck > /tmp/cxrma/w$N.tc.log 2>&1; echo \"rc=\$?\"; grep -E \"error TS\" /tmp/cxrma/w$N.tc.log | head -40
echo \"== lint:source\"; timeout 10m pnpm -s lint:source > /tmp/cxrma/w$N.ls.log 2>&1; echo \"rc=\$?\"; grep -E \"exited with code [1-9]|^ *[0-9]+:[0-9]+ +error|✖|ERROR|FAIL\" /tmp/cxrma/w$N.ls.log | head -40
if [ -n \"$TESTS\" ]; then echo \"== vitest $TESTS\"; timeout 15m npx vitest run $TESTS > /tmp/cxrma/w$N.vt.log 2>&1; echo \"rc=\$?\"; grep -E \"FAIL|✗|×|Test Files|Tests \" /tmp/cxrma/w$N.vt.log | head -40; fi
'"
