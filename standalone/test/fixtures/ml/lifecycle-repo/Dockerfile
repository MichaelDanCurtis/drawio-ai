FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY serve/ serve/
CMD ["uvicorn", "serve.app:app", "--host", "0.0.0.0", "--port", "8080"]
