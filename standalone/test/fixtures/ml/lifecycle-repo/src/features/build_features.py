import pandas as pd
from feast import FeatureStore
from sklearn.preprocessing import StandardScaler

FEATURES = ["sessions_7d", "spend_30d", "tenure_days"]

def build():
    events = pd.read_parquet("data/raw/events.parquet")
    store = FeatureStore(repo_path="feature_repo")
    df = store.get_historical_features(entity_df=events, features=["user_stats:sessions_7d"]).to_df()
    df[FEATURES] = StandardScaler().fit_transform(df[FEATURES])
    df.to_parquet("data/features.parquet")
