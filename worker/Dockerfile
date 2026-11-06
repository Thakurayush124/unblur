FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml ./
COPY unblur ./unblur
COPY cli.py ./
RUN pip install --no-cache-dir ".[mongo]"
# Repos to analyse are mounted at /repos; git needs to trust them.
RUN git config --global --add safe.directory '*'
ENTRYPOINT ["python", "cli.py"]
