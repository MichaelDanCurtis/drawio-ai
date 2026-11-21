from metaflow import FlowSpec, step, resources

class TrainFlow(FlowSpec):
    @step
    def start(self):
        self.alphas = [0.1, 1.0]
        self.next(self.train, foreach="alphas")

    @resources(memory=8000, cpu=4)
    @step
    def train(self):
        self.next(self.join)

    @step
    def join(self, inputs):
        self.next(self.end)

    @step
    def end(self):
        pass

if __name__ == "__main__":
    TrainFlow()
