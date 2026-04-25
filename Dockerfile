FROM python:3.12-slim

WORKDIR /app

# System deps: bcrypt is a wheel on linux/amd64 + arm64 so no compile toolchain needed.

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Default to the /app/data volume mount; override via env if desired.
ENV AEYES_ENV=prod \
    AEYES_DB_PATH=/app/data/aeyes.db

# Ensure /app/data exists even before the volume is mounted (init_db will create the file).
RUN mkdir -p /app/data

EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
