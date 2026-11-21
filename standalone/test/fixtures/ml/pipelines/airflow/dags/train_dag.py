from datetime import datetime

from airflow import DAG
from airflow.decorators import task
from airflow.operators.bash import BashOperator
from airflow.operators.empty import EmptyOperator
from airflow.providers.amazon.aws.operators.sagemaker import SageMakerTrainingOperator
from airflow.utils.trigger_rule import TriggerRule

default_args = {"owner": "ml", "retries": 1}

with DAG(
    dag_id="churn_training",
    schedule="@daily",  # every day >> at midnight
    start_date=datetime(2024, 1, 1),
    default_args=default_args,
    catchup=False,
) as dag:
    start = EmptyOperator(task_id="start")

    extract = BashOperator(
        task_id="extract_events",
        bash_command="python jobs/extract.py --date {{ ds }}",
    )
    validate = BashOperator(task_id="validate_data", bash_command="great_expectations checkpoint run events")

    train = SageMakerTrainingOperator(
        task_id="train_model",
        config={"TrainingJobName": "churn-{{ ds_nodash }}"},
        wait_for_completion=True,
    )

    @task
    def evaluate(model_uri: str) -> dict:
        return {"auc": 0.9}

    @task.branch(task_id="gate")
    def quality_gate(metrics: dict):
        return "register" if metrics["auc"] > 0.8 else "notify_failure"

    @task(task_id="register")
    def register_model():
        pass

    notify = BashOperator(task_id="notify_failure", bash_command="echo failed", trigger_rule=TriggerRule.ONE_FAILED)
    end = EmptyOperator(task_id="end", trigger_rule="none_failed")

    metrics = evaluate(train.output)
    gate = quality_gate(metrics)

    start >> extract >> validate >> train
    gate >> [register_model(), notify]
    [notify] >> end
