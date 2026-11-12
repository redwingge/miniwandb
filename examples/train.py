"""Small runnable training example; no torch, wandb or network required."""

import math
import uuid

import miniwandb as wandb


def main():
    # Each fold is an independent run in one shared CV group.
    cv_id = uuid.uuid4().hex[:12]
    for fold in range(2):
        with wandb.init(project="guard_RBP", name="MP_fold_%d" % fold,
                        config={"cv_id": cv_id, "cv_name": "MP_demo", "n_splits": 2,
                                "fold": fold, "learning_rate": 0.0001, "epochs": 20},
                        notes="API 使用示例；指标为模拟数据") as run:
            for epoch in range(20):
                run.log({"epoch": epoch, "train/loss": math.exp(-epoch / 6),
                         "valid/auroc": 0.6 + 0.35 * (1 - math.exp(-epoch / 8))}, step=epoch)


if __name__ == "__main__":
    main()
