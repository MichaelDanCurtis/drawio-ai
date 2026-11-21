import mlflow.pyfunc
from fastapi import FastAPI

app = FastAPI()
model = mlflow.pyfunc.load_model("models:/churn-model/Production")

@app.post("/predict")
def predict(payload: dict):
    return {"churn": float(model.predict([payload])[0])}
