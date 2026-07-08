from __future__ import annotations

import argparse

from claimguard.config import load_config
from claimguard.pipeline import run_pipeline


def main():
    parser = argparse.ArgumentParser(description="ClaimGuard data generator")
    parser.add_argument("--config", default="generation_config.yaml")
    args = parser.parse_args()

    config = load_config(args.config)
    run_pipeline(config)


if __name__ == "__main__":
    main()
