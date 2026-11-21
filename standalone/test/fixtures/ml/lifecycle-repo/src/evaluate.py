import joblib
import pandas as pd
from sklearn.metrics import roc_auc_score, classification_report

def main():
    model = joblib.load("models/model.joblib")
    df = pd.read_parquet("data/features.parquet")
    print(roc_auc_score(df["churned"], model.predict_proba(df)[:, 1]))
    print(classification_report(df["churned"], model.predict(df)))
