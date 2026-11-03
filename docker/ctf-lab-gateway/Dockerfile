FROM python:3.12.8-slim

WORKDIR /app
COPY server.py /app/server.py

RUN chmod 0555 /app/server.py

EXPOSE 8090
ENTRYPOINT ["python3", "/app/server.py"]
