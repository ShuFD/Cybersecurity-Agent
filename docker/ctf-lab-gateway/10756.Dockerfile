FROM ctf-mcp:ubuntu24-core

WORKDIR /challenge

COPY --chmod=0555 pwn /challenge/pwn
COPY --chmod=0555 libc.so.6 /challenge/libc.so.6
COPY --chmod=0555 ld-linux-x86-64.so.2 /challenge/ld-linux-x86-64.so.2

# The artifact is a stdin/stdout menu binary, so expose one isolated process per TCP connection.
ENTRYPOINT ["python3", "-c", "import socket, subprocess\nlistener = socket.socket()\nlistener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\nlistener.bind(('0.0.0.0', 31337))\nlistener.listen(8)\nwhile True:\n    client, _ = listener.accept()\n    process = subprocess.Popen(['./pwn'], cwd='/challenge', stdin=client, stdout=client, stderr=client)\n    process.wait()\n    client.close()"]
