import joblib
import mlflow
import pandas as pd
import xgboost as xgb
from sklearn.model_selection import train_test_split

from src.features.build_features import FEATURES

def main(n_estimators: int = 200):
    df = pd.read_parquet("data/features.parquet")
    X_train, X_test, y_train, y_test = train_test_split(df[FEATURES], df["churned"])
    mlflow.set_experiment("churn-classifier")
    with mlflow.start_run():
        model = xgb.XGBClassifier(n_estimators=n_estimators)
        model.fit(X_train, y_train)
        mlflow.log_param("n_estimators", n_estimators)
        mlflow.xgboost.log_model(model, "model", registered_model_name="churn-model")
    joblib.dump(model, "models/model.joblib")

if __name__ == "__main__":
    main()
