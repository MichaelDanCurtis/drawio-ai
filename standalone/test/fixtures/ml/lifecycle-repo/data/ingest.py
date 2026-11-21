"""Pulls the last 90 days of events from the warehouse."""
import pandas as pd
from sqlalchemy import create_engine

def main():
    engine = create_engine("postgresql://readonly@warehouse/events")
    df = pd.read_sql("SELECT * FROM events WHERE ts > now() - interval '90 days'", engine)
    df.to_parquet("data/raw/events.parquet")

if __name__ == "__main__":
    main()
