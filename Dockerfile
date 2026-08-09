FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    DATA_DIR=/data

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY frontend ./frontend

RUN useradd --create-home --uid 1000 app \
    && mkdir -p /data \
    && chown app:app /data

USER app
EXPOSE 8000

# ワーカー数は WEB_CONCURRENCY で指定する（gunicorn が参照する）。
# 増やす場合は PostgreSQL を推奨。SQLite だと書き込みが直列化される。
ENV WEB_CONCURRENCY=1
CMD ["gunicorn", "-k", "uvicorn.workers.UvicornWorker", "app.main:app", \
     "--bind", "0.0.0.0:8000", "--access-logfile", "-"]
