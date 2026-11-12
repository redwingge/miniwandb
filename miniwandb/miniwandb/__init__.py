"""Tiny local alternative for wandb.init(), wandb.log(), wandb.finish()."""

from .tracker import Run
from .output import attach_output

__version__ = "0.1.0"
__all__ = ["Run", "init", "log", "log_evaluation", "log_output", "attach_output", "finish", "run"]

run = None


def init(project="default", name=None, config=None, notes="", tags=None, dir=None,
         id=None, resume=False, capture_output=False):
    """Start the module-level run. An existing run is finished first."""
    global run
    finish()
    run = Run(project=project, name=name, config=config, notes=notes, tags=tags,
              dir=dir, id=id, resume=resume, capture_output=capture_output)
    return run


def log(data, step=None):
    if run is None:
        raise RuntimeError("Call miniwandb.init() before log()")
    run.log(data, step=step)


def log_output(text):
    if run is None:
        raise RuntimeError("Call miniwandb.init() before log_output()")
    run.log_output(text)


def finish(exit_code=0):
    global run
    if run is not None:
        run.finish(exit_code=exit_code)
        run = None


def log_evaluation(dataset, metrics, *, name="final", metadata=None, replace=False, run_id=None, dir=None):
    """Save final scores on the active run, or attach to an explicit finished run."""
    if run_id is None:
        if run is None:
            raise RuntimeError("Call init() first, or supply run_id and dir for an existing experiment")
        if dir is not None:
            raise ValueError("dir is selected at init(); supply run_id when writing to an explicit directory")
        return run.log_evaluation(dataset, metrics, name=name, metadata=metadata, replace=replace)
    from .evaluation import log_evaluation as save
    return save(dataset, metrics, run_id=run_id, dir=dir, name=name, metadata=metadata, replace=replace)
