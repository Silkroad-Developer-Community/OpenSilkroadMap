import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
MAP_DIR = ROOT_DIR / "map"
ASSETS_DIR = MAP_DIR / "public" / "assets"
DIST_DIR = MAP_DIR / "dist"
PUBLISHED_BRANCH = "gh-pages"
WORKFLOW_PATH = Path(".github") / "workflows" / "deploy-pages.yml"
REQUIRED_ARCHIVES = (
    "world",
    "navmesh_world",
    "32769_1",
    "32769_2",
    "32769_3",
    "32769_4",
    "32775",
    "32774",
    "32773",
    "32772",
    "32771",
    "32770",
    "32784",
    "32786",
    "32785",
)


def run(command: list[str], cwd: Path, env: dict[str, str] | None = None, capture: bool = False) -> str:
    command_env = os.environ.copy()
    if env:
        command_env.update(env)
    command_env["GIT_TERMINAL_PROMPT"] = "0"
    command_env["GIT_LFS_SKIP_SMUDGE"] = "1"
    result = subprocess.run(
        command,
        cwd=cwd,
        env=command_env,
        check=False,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    if result.returncode:
        details = result.stderr.strip() if capture and result.stderr else ""
        message = f"Command failed ({result.returncode}): {' '.join(command)}"
        raise RuntimeError(f"{message}: {details}" if details else message)
    return result.stdout.strip() if capture and result.stdout else ""


def validate_runtime_assets() -> list[str]:
    missing_archives = [name for name in REQUIRED_ARCHIVES if not (ASSETS_DIR / f"{name}.pmtiles").is_file()]
    manifest_path = ASSETS_DIR / "navmesh_dungeons.json"
    required_files = [
        ASSETS_DIR / "npcs.json",
        ASSETS_DIR / "teleports.json",
        ASSETS_DIR / "icons" / "mm_sign_npc.png",
        manifest_path,
    ]
    missing_files = [str(path.relative_to(ROOT_DIR)) for path in required_files if not path.is_file()]
    if missing_archives or missing_files:
        missing = [f"{name}.pmtiles" for name in missing_archives] + missing_files
        raise RuntimeError(
            "Required generated runtime assets are missing:\n  "
            + "\n  ".join(missing)
            + "\nRun the asset-generation scripts first, then retry."
        )

    with manifest_path.open(encoding="utf-8") as manifest_file:
        manifest = json.load(manifest_file)

    archives = {
        floor["archive"]
        for floors in manifest.values()
        for floor in floors
        if isinstance(floor, dict) and isinstance(floor.get("archive"), str)
    }
    missing_dungeon_archives = sorted(name for name in archives if not (ASSETS_DIR / name).is_file())
    if missing_dungeon_archives:
        raise RuntimeError("Dungeon navmesh PMTiles are missing:\n  " + "\n  ".join(missing_dungeon_archives))
    return sorted(name.removesuffix(".pmtiles") for name in archives)


def repository_base_path() -> str:
    remote = run(["git", "remote", "get-url", "origin"], ROOT_DIR, capture=True)
    match = re.search(r"(?:github\.com[:/])[^/]+/([^/]+?)(?:\.git)?$", remote.rstrip("/"))
    if not match:
        raise RuntimeError(f"Could not derive the GitHub Pages path from origin remote: {remote}")
    return f"/{match.group(1)}/"


def stage_runtime_assets(destination: Path, dungeon_navmesh_archives: list[str]) -> None:
    assets_destination = destination / "assets"
    assets_destination.mkdir(parents=True)

    archive_names = [f"{name}.pmtiles" for name in (*REQUIRED_ARCHIVES, *dungeon_navmesh_archives)]
    for archive_name in archive_names:
        shutil.copy2(ASSETS_DIR / archive_name, assets_destination / archive_name)

    for filename in ("npcs.json", "teleports.json", "navmesh_dungeons.json"):
        shutil.copy2(ASSETS_DIR / filename, assets_destination / filename)

    shutil.copytree(ASSETS_DIR / "icons", assets_destination / "icons")


def build_site(dungeon_navmesh_archives: list[str]) -> None:
    env = os.environ.copy()
    env["PAGES_BASE_PATH"] = repository_base_path()
    with tempfile.TemporaryDirectory(prefix="opensilkroad-runtime-") as public_dir:
        stage_runtime_assets(Path(public_dir), dungeon_navmesh_archives)
        env["PAGES_PUBLIC_DIR"] = public_dir
        run(["deno", "task", "build"], MAP_DIR, env=env)


def validate_site_size(site_dir: Path) -> None:
    files = [path for path in site_dir.rglob("*") if path.is_file()]
    oversized_files = [(path, path.stat().st_size) for path in files if path.stat().st_size > 2_000_000_000]
    if oversized_files:
        names = "\n  ".join(
            f"{path.relative_to(site_dir)} ({size / 1024 / 1024:.1f} MiB)" for path, size in oversized_files
        )
        raise RuntimeError("Git LFS rejects individual files larger than 2 GB:\n  " + names)

    total_size = sum(path.stat().st_size for path in files)
    if total_size > 1_000_000_000:
        raise RuntimeError(f"Pages site exceeds the 1 GB size limit ({total_size / 1_000_000_000:.2f} GB).")


def publish_site() -> None:
    remote = run(["git", "remote", "get-url", "origin"], ROOT_DIR, capture=True)
    workflow_source = ROOT_DIR / WORKFLOW_PATH

    with tempfile.TemporaryDirectory(prefix="opensilkroad-pages-") as temp_dir:
        publish_dir = Path(temp_dir)
        run(["git", "init"], publish_dir)
        run(["git", "lfs", "install", "--local"], publish_dir)
        run(["git", "remote", "add", "origin", remote], publish_dir)
        remote_branch = run(
            ["git", "ls-remote", "--heads", "origin", f"refs/heads/{PUBLISHED_BRANCH}"],
            publish_dir,
            capture=True,
        )
        if remote_branch:
            run(["git", "fetch", "--depth=1", "origin", PUBLISHED_BRANCH], publish_dir)
            run(["git", "checkout", "-b", PUBLISHED_BRANCH, "FETCH_HEAD"], publish_dir)
        else:
            run(["git", "checkout", "--orphan", PUBLISHED_BRANCH], publish_dir)

        for child in publish_dir.iterdir():
            if child.name == ".git":
                continue
            shutil.rmtree(child) if child.is_dir() else child.unlink()

        site_dir = publish_dir / "site"
        shutil.copytree(DIST_DIR, site_dir)
        validate_site_size(site_dir)
        run(["git", "lfs", "track", "site/assets/*.pmtiles"], publish_dir)
        workflow_destination = publish_dir / WORKFLOW_PATH
        workflow_destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(workflow_source, workflow_destination)

        run(["git", "config", "user.name", "OpenSilkroadMap Pages"], publish_dir)
        run(["git", "config", "user.email", "pages-deploy@users.noreply.github.com"], publish_dir)
        run(["git", "add", "--all"], publish_dir)
        run(["git", "add", "--renormalize", "--", "site/assets"], publish_dir)
        diff_result = subprocess.run(
            ["git", "diff", "--cached", "--quiet"],
            cwd=publish_dir,
            check=False,
        )
        if diff_result.returncode == 0:
            print("The generated Pages site is already up to date.")
            return
        if diff_result.returncode != 1:
            raise RuntimeError("Could not determine whether the generated Pages site changed.")

        run(["git", "commit", "-m", "Deploy GitHub Pages site"], publish_dir)
        run(["git", "push", "--set-upstream", "origin", PUBLISHED_BRANCH], publish_dir)


def main() -> None:
    dungeon_navmesh_archives = validate_runtime_assets()
    build_site(dungeon_navmesh_archives)
    publish_site()
    print("Pages site pushed to gh-pages. GitHub Actions will publish it.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, json.JSONDecodeError) as error:
        raise SystemExit(str(error)) from error
