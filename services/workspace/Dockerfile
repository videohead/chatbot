FROM python:3.12-slim

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
COPY --chmod=0444 server.py /app/server.py
COPY --chmod=0555 git-askpass.py /app/git-askpass.py

RUN mkdir -p /data /workspace/creative /workspace/nvidia \
    && chown -R 1000:1000 /data /workspace

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

EXPOSE 8080
CMD ["python", "/app/server.py"]
