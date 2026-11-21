"""Run crapper (unclebob/crapper, pinned in tools.json) and print its entries as JSON lines.

crapper's own outputs (the table and `.metrics/crap.edn`) carry no file path or line, so a function
cannot be joined with git churn or a findings list. This walks the same files with the same coverage
bundle and scoring as `crapper.cli.run`, writes crap.edn the same way, and adds `path` and `line`.
Arguments are crapper's own (`--use-existing-coverage`, `-s <dir>`, filters, ...).
"""

import json
import sys

from crapper.analyze import _coverage
from crapper.cli import _coverage_bundle, parse_args, select_files
from crapper.crap import make_entry
from crapper.discover import language_of
from crapper.languages import functions_in_file
from crapper.metrics import write_metrics


def main(argv: list[str]) -> int:
    options = parse_args(argv)
    if options.action == "help":
        print(options.message)
        return options.exit_code
    root = options.project_root.resolve()
    files = select_files(options)
    bundle = _coverage_bundle(options, root, files)
    if bundle is not None:
        bundle.bind_sources([file.relative_to(root).as_posix() for file in files])
    entries = []
    for file in files:
        language = language_of(file)
        if language is None:
            continue
        relative = file.relative_to(root).as_posix()
        source = file.read_text(encoding="utf-8", errors="replace")
        for function in functions_in_file(language, source, relative, str(root)):
            entry = make_entry(function, _coverage(bundle, function))
            entries.append(entry)
            print(json.dumps({
                "path": relative,
                "line": function.start_line,
                "endLine": function.end_line,
                "name": entry.name,
                "namespace": entry.namespace,
                "language": entry.language,
                "complexity": entry.complexity,
                "coverage": entry.coverage,
                "crap": entry.crap,
            }))
    write_metrics(entries, root)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
