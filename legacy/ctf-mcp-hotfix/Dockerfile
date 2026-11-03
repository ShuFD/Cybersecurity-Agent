ARG BASE_IMAGE=ctf-mcp:ubuntu24-core
FROM ${BASE_IMAGE}

USER root
COPY ctf-mcp/server.py /opt/ctf-mcp/server.py
RUN chmod 0644 /opt/ctf-mcp/server.py

ENV CTF_WORKDIR=/work
ENV CTF_MCP_TRANSPORT=streamable-http
ENV CTF_MCP_HOST=0.0.0.0
ENV CTF_MCP_PORT=8000

USER ctf
WORKDIR /work
EXPOSE 8000

CMD ["python3", "/opt/ctf-mcp/server.py", "--transport", "streamable-http", "--host", "0.0.0.0", "--port", "8000"]
