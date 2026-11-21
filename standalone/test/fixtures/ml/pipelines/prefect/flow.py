from prefect import flow, task

@task
def load():
    return [1, 2, 3]

@task
def fit(data):
    return sum(data)

@flow(name="nightly-train")
def nightly():
    fit(load())
