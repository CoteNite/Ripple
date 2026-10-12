import json
import os
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] in {'--prepare-installation-data', '--confirm-installation-data', '--delete-installation-data'}:
        from app.services.installation_data import prepare_installation_data, confirm_installation_data, delete_installation_data
        try:
            installation = Path(sys.argv[2])
            if sys.argv[1] == '--prepare-installation-data':
                result = prepare_installation_data(installation, [Path(value) for value in sys.argv[3:]])
                print(json.dumps(result, ensure_ascii=True))
            elif sys.argv[1] == '--confirm-installation-data':
                confirm_installation_data(installation)
            else:
                delete_installation_data(installation)
            return
        except Exception as error:
            print(str(error), file=sys.stderr)
            raise SystemExit(1) from error
    import uvicorn
    from app.main import app
    host = os.environ.get("RSSREADER_HOST", "127.0.0.1")
    port = int(os.environ.get("RSSREADER_PORT", "8000"))
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
