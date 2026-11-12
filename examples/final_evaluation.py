"""Simulated two-model, three-fold final evaluation; uses no GPU or network."""
import uuid

import miniwandb as wandb


def main():
    for model, lr in (("MP", 5e-5), ("MAP", 1e-4)):
        cv_id = uuid.uuid4().hex[:12]
        for fold in range(3):
            with wandb.init(project="final_evaluation_demo", name=f"{model}_fold_{fold}",
                            config={"cv_id": cv_id, "cv_name": f"{model}_lr_{lr}",
                                    "fold": fold, "n_splits": 3, "model": model, "lr": lr}) as run:
                # Replace simulated scores with evaluation of your saved checkpoint.
                score = 0.65 + 0.04 * fold + (0.06 if model == "MAP" else 0)
                run.log({"valid/mcc": score - 0.05}, step=0)
                for dataset, offset in (("test_1580", 0), ("test_46541", -0.08)):
                    run.log_evaluation(dataset, {"mcc": score + offset, "sp": score + 0.1 + offset},
                                       metadata={"checkpoint": "best", "threshold": 0.5})


if __name__ == "__main__":
    main()
