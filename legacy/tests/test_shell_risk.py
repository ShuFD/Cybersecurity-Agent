from shell_risk import classify_python_code, classify_shell_command, split_shell_commands


def test_split_shell_commands_handles_connectors_and_pipes():
    assert split_shell_commands("git status && rm -rf build | cat") == [
        "git status",
        "rm -rf build",
        "cat",
    ]


def test_split_shell_commands_does_not_split_force_output_redirection():
    assert split_shell_commands("echo data >| out.txt") == ["echo data '>|' out.txt"]


def test_classify_shell_command_fails_closed_when_split_limit_is_exceeded():
    command = "; ".join(["pwd"] * 51 + ["rm -rf /tmp/demo"])

    report = classify_shell_command(command)

    assert report.level == "write"
    assert report.reason == "command split limit exceeded"
    assert report.matched_command == command


def test_classify_shell_command_fails_closed_when_nested_split_limit_is_exceeded():
    nested = "; ".join(["pwd"] * 51 + ["rm -rf /tmp/demo"])

    report = classify_shell_command(f"bash -c {nested!r}")

    assert report.level == "write"
    assert report.reason == "command split limit exceeded"
    assert report.matched_command == nested


def test_classify_shell_command_detects_nested_shell_delete():
    report = classify_shell_command("bash -c 'echo ok; rm -rf /tmp/demo'")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert any(command.startswith("bash -c") for command in report.commands)


def test_classify_shell_command_detects_subshell_delete():
    report = classify_shell_command("(rm -rf /tmp/demo)")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_brace_group_delete():
    report = classify_shell_command("{ rm -rf /tmp/demo; }")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_negated_delete():
    report = classify_shell_command("! rm -rf /tmp/demo")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_if_negated_delete():
    report = classify_shell_command("if ! rm -rf /tmp/demo; then echo failed; fi")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_coproc_delete():
    report = classify_shell_command("coproc rm -rf /tmp/demo")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_named_coproc_group_delete():
    report = classify_shell_command("coproc cleaner { rm -rf /tmp/demo; }")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_if_branch_delete():
    report = classify_shell_command("if true; then rm -rf /tmp/demo; fi")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_for_loop_delete():
    report = classify_shell_command("for name in demo; do rm -rf /tmp/demo; done")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_case_branch_delete():
    report = classify_shell_command("case demo in demo) rm -rf /tmp/demo;; esac")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_called_function_delete():
    report = classify_shell_command("cleanup(){ rm -rf /tmp/demo; }; cleanup")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_called_function_keyword_delete():
    report = classify_shell_command("function cleanup { rm -rf /tmp/demo; }; cleanup")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_trap_delete():
    report = classify_shell_command("trap 'rm -rf /tmp/demo' EXIT")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_trap_connector_delete():
    report = classify_shell_command("trap 'echo ok; rm -rf /tmp/demo' 0")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_nested_shell_trap_delete():
    report = classify_shell_command("bash -c \"trap 'rm -rf /tmp/demo' EXIT\"")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_ansi_c_quoted_nested_shell_delete():
    report = classify_shell_command("bash -c $'echo ok; rm -rf /tmp/demo'")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_decodes_ansi_c_quoted_shell_escapes():
    report = classify_shell_command("bash -c $'rm\\x20-rf /tmp/demo'")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"


def test_classify_shell_command_detects_ansi_c_quoted_eval_delete():
    report = classify_shell_command("eval $'rm -rf /tmp/demo'")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"


def test_classify_shell_command_detects_compound_shell_c_option_delete():
    bash_report = classify_shell_command("bash -lc 'echo ok; rm -rf /tmp/demo'")
    sh_report = classify_shell_command("sh -ec 'rm -rf /tmp/demo'")

    assert bash_report.level == "destructive"
    assert bash_report.matched_command == "rm -rf /tmp/demo"
    assert bash_report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in bash_report.commands
    assert sh_report.level == "destructive"
    assert sh_report.matched_command == "rm -rf /tmp/demo"


def test_classify_shell_command_detects_sudo_nested_delete():
    report = classify_shell_command("sudo rm -rf /tmp/demo")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert any(command.startswith("sudo") for command in report.commands)


def test_classify_shell_command_detects_absolute_rm_delete():
    report = classify_shell_command("/bin/rm -rf /tmp/demo")

    assert report.level == "destructive"
    assert report.matched_command == "/bin/rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"


def test_classify_shell_command_detects_rm_delete_as_destructive():
    for command in [
        "rm file.txt",
        "rm -f file.txt",
        "rm -r build",
        "rm --recursive build",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.matched_command == command
        assert report.reason == "file delete command"


def test_classify_shell_command_detects_unlink_delete_as_destructive():
    report = classify_shell_command("unlink file.txt")

    assert report.level == "destructive"
    assert report.matched_command == "unlink file.txt"
    assert report.reason == "file delete command"


def test_classify_shell_command_detects_container_resource_delete_as_destructive():
    for command in [
        "docker rm old-container",
        "docker rmi image:old",
        "docker volume rm data-vol",
        "docker volume prune -f",
        "docker system prune -af",
        "docker compose down -v",
        "docker compose rm -f old-service",
        "docker-compose down --volumes",
        "docker-compose rm --force old-service",
        "podman rm old-container",
        "podman compose down --volumes",
        "podman system prune --all --force",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.matched_command == command
        assert report.reason == "container resource delete"


def test_classify_shell_command_detects_infrastructure_resource_delete_as_destructive():
    for command in [
        "kubectl delete pod demo",
        "kubectl delete -f deployment.yaml",
        "helm uninstall demo",
        "helm delete demo",
        "terraform destroy -auto-approve",
        "terraform apply -destroy -auto-approve",
        "tofu destroy -auto-approve",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.matched_command == command
        assert report.reason == "infrastructure resource delete"


def test_classify_shell_command_detects_cloud_resource_delete_as_destructive():
    for command in [
        "aws s3 rm s3://bucket/key",
        "aws cloudformation delete-stack --stack-name demo",
        "aws ec2 terminate-instances --instance-ids i-123",
        "aws iam delete-user --user-name demo",
        "gcloud compute instances delete demo --zone us-central1-a",
        "gcloud projects delete demo-project",
        "az group delete --name demo --yes",
        "az vm delete --resource-group demo --name vm --yes",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.matched_command == command
        assert report.reason == "cloud resource delete"


def test_classify_shell_command_ignores_cloud_option_values_named_delete():
    for command in [
        "aws ec2 describe-instances --query delete",
        "gcloud compute instances list --format delete",
        "az group list --query delete",
    ]:
        report = classify_shell_command(command)

        assert report.level == "write"
        assert report.reason == "unknown command"


def test_classify_shell_command_detects_database_delete_as_destructive():
    for command in [
        'psql -c "DROP DATABASE demo"',
        'psql --command "DROP TABLE users"',
        'mysql -e "DROP DATABASE demo"',
        'sqlite3 app.db "DROP TABLE users"',
        'sqlite3 app.db "DELETE FROM users"',
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.reason == "database destructive command"


def test_classify_shell_command_detects_redis_delete_as_destructive():
    for command in [
        "redis-cli FLUSHALL",
        "redis-cli FLUSHDB",
        "redis-cli DEL key",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.matched_command == command
        assert report.reason == "database destructive command"


def test_classify_shell_command_detects_package_removal_as_destructive():
    for command in [
        "apt remove nginx",
        "apt-get purge nginx",
        "dnf erase postgresql",
        "yum remove mysql",
        "brew uninstall node",
        "pip uninstall requests -y",
        "pip3 uninstall requests -y",
        "python -m pip uninstall requests -y",
        "conda remove numpy -y",
        "mamba remove numpy -y",
        "npm uninstall left-pad",
        "npm rm left-pad",
        "npm unpublish left-pad --force",
        "cargo uninstall ripgrep",
        "gem uninstall rails",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.matched_command == command
        assert report.reason == "package removal command"


def test_classify_shell_command_detects_absolute_sudo_nested_delete():
    report = classify_shell_command("/usr/bin/sudo rm -rf /tmp/demo")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_command_wrapper_delete():
    report = classify_shell_command("command rm -rf /tmp/demo")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_exec_wrapper_delete():
    report = classify_shell_command("exec rm -rf /tmp/demo")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_builtin_eval_delete():
    report = classify_shell_command("builtin eval 'rm -rf /tmp/demo'")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "eval 'rm -rf /tmp/demo'" in report.commands
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_builtin_command_wrapper_delete():
    report = classify_shell_command("builtin command rm -rf /tmp/demo")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "command rm -rf /tmp/demo" in report.commands
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_builtin_exec_wrapper_delete():
    report = classify_shell_command("builtin exec rm -rf /tmp/demo")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "exec rm -rf /tmp/demo" in report.commands
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_sudo_clustered_option_nested_delete():
    report = classify_shell_command("sudo -Eu root rm -rf /tmp/demo")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_sudo_nested_git_write():
    report = classify_shell_command("sudo -u root git push origin main")

    assert report.level == "write"
    assert report.matched_command == "git push origin main"
    assert report.reason == "git remote write"


def test_classify_shell_command_detects_rm_split_recursive_force_flags():
    report = classify_shell_command("rm -r -f /tmp/demo")

    assert report.level == "destructive"
    assert report.matched_command == "rm -r -f /tmp/demo"
    assert report.reason == "rm recursive force"


def test_classify_shell_command_detects_rm_long_recursive_force_flags():
    report = classify_shell_command("rm --recursive --force /tmp/demo")

    assert report.level == "destructive"
    assert report.matched_command == "rm --recursive --force /tmp/demo"
    assert report.reason == "rm recursive force"


def test_classify_shell_command_does_not_treat_rm_force_only_as_recursive_force():
    report = classify_shell_command("rm --force /tmp/demo")

    assert report.level == "destructive"
    assert report.reason == "file delete command"


def test_classify_shell_command_detects_rm_uppercase_recursive_force_flag():
    report = classify_shell_command("rm -Rf /tmp/demo")

    assert report.level == "destructive"
    assert report.matched_command == "rm -Rf /tmp/demo"
    assert report.reason == "rm recursive force"


def test_classify_shell_command_detects_shred_unlink_as_destructive():
    report = classify_shell_command("shred -u /tmp/demo")

    assert report.level == "destructive"
    assert report.matched_command == "shred -u /tmp/demo"
    assert report.reason == "shred file overwrite"


def test_classify_shell_command_marks_sed_in_place_as_write():
    report = classify_shell_command("sed -i 's/a/b/' file.txt")

    assert report.level == "write"
    assert report.matched_command == "sed -i s/a/b/ file.txt"
    assert report.reason == "sed in-place edit"


def test_classify_shell_command_marks_sed_write_script_as_write():
    for command in [
        "sed -n 'w out.txt' input.txt",
        "sed -n '/needle/w out.txt' input.txt",
        "sed -e 's/foo/bar/w out.txt' input.txt",
    ]:
        report = classify_shell_command(command)

        assert report.level == "write"
        assert report.reason == "sed write file"


def test_classify_shell_command_marks_sed_script_file_as_write():
    for command in [
        "sed -f script.sed input.txt",
        "sed --file=script.sed input.txt",
    ]:
        report = classify_shell_command(command)

        assert report.level == "write"
        assert report.reason == "sed script file"


def test_classify_shell_command_marks_less_log_file_as_write():
    for command in [
        "less -o less.log input.txt",
        "less -O less.log input.txt",
        "less --log-file=less.log input.txt",
        "less --LOG-FILE=less.log input.txt",
    ]:
        report = classify_shell_command(command)

        assert report.level == "write"
        assert report.reason == "less log file"


def test_classify_shell_command_marks_output_redirection_as_write():
    report = classify_shell_command("grep needle input.txt > out.txt")

    assert report.level == "write"
    assert report.matched_command == "grep needle input.txt '>' out.txt"
    assert report.reason == "output redirection"


def test_classify_shell_command_marks_fd_output_redirection_as_write():
    report = classify_shell_command("cat input.txt 1> out.txt")

    assert report.level == "write"
    assert report.reason == "output redirection"


def test_classify_shell_command_marks_time_output_wrapper_as_write():
    for command in [
        "time -o timing.txt ls",
        "time --output=timing.txt ls",
        "command time -o timing.txt ls",
        "timeout 5 time -o timing.txt ls",
    ]:
        report = classify_shell_command(command)

        assert report.level == "write"
        assert report.reason == "time output file"


def test_classify_shell_command_marks_find_file_output_actions_as_write():
    for command in [
        "find . -fprint out.txt",
        "find . -fprint0 out.txt",
        "find . -fprintf out.txt '%p\\n'",
        "find . -fls out.txt",
    ]:
        report = classify_shell_command(command)

        assert report.level == "write"
        assert report.reason == "find file output"


def test_classify_shell_command_detects_git_reset_hard_as_destructive():
    report = classify_shell_command("git reset --hard HEAD")

    assert report.level == "destructive"
    assert report.matched_command == "git reset --hard HEAD"
    assert report.reason == "git reset hard"


def test_classify_shell_command_detects_git_clean_force_as_destructive():
    report = classify_shell_command("git clean -fdx")

    assert report.level == "destructive"
    assert report.matched_command == "git clean -fdx"
    assert report.reason == "git clean force delete"


def test_classify_shell_command_does_not_mark_git_clean_dry_run_as_destructive():
    report = classify_shell_command("git clean -nfd")

    assert report.level == "readonly"
    assert report.matched_command == "git clean -nfd"
    assert report.reason == "git clean dry run"


def test_classify_shell_command_detects_git_branch_delete_as_destructive():
    for command in [
        "git branch -D old-feature",
        "git branch --delete old-feature",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.matched_command == command
        assert report.reason == "git branch delete"


def test_classify_shell_command_marks_git_branch_rename_as_write():
    for command in [
        "git branch -m old-feature new-feature",
        "git branch --move old-feature new-feature",
    ]:
        report = classify_shell_command(command)

        assert report.level == "write"
        assert report.matched_command == command
        assert report.reason == "git branch write"


def test_classify_shell_command_detects_git_rm_as_destructive():
    for command in [
        "git rm important.txt",
        "git rm -r olddir",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.matched_command == command
        assert report.reason == "git rm delete"


def test_classify_shell_command_detects_git_tag_delete_as_destructive():
    for command in [
        "git tag -d v1.0.0",
        "git tag --delete v1.0.0",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.matched_command == command
        assert report.reason == "git tag delete"


def test_classify_shell_command_detects_git_update_ref_delete_as_destructive():
    for command in [
        "git update-ref -d refs/heads/old",
        "git update-ref --delete refs/heads/old",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.matched_command == command
        assert report.reason == "git ref delete"


def test_classify_shell_command_detects_git_symbolic_ref_delete_as_destructive():
    for command in [
        "git symbolic-ref --delete refs/remotes/origin/HEAD",
        "git symbolic-ref -d refs/remotes/origin/HEAD",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.matched_command == command
        assert report.reason == "git ref delete"


def test_classify_shell_command_detects_git_replace_delete_as_destructive():
    for command in [
        "git replace -d abc123",
        "git replace --delete abc123",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.matched_command == command
        assert report.reason == "git ref delete"


def test_classify_shell_command_detects_git_notes_delete_as_destructive():
    for command in [
        "git notes remove HEAD",
        "git notes prune",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.matched_command == command
        assert report.reason == "git ref delete"


def test_classify_shell_command_detects_git_submodule_force_deinit_as_destructive():
    for command in [
        "git submodule deinit -f vendor/lib",
        "git submodule deinit --force --all",
        "git submodule --quiet deinit --force vendor/lib",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.matched_command == command
        assert report.reason == "git submodule forced deinit"


def test_classify_shell_command_keeps_git_submodule_update_as_write():
    report = classify_shell_command("git submodule update --init")

    assert report.level == "write"
    assert report.matched_command == "git submodule update --init"


def test_classify_shell_command_marks_git_restore_staged_only_as_write():
    for command in [
        "git restore --staged file.txt",
        "git restore --source HEAD --staged file.txt",
        "git restore -S file.txt",
    ]:
        report = classify_shell_command(command)

        assert report.level == "write"
        assert report.matched_command == command
        assert report.reason == "git restore index"


def test_classify_shell_command_detects_git_restore_worktree_as_destructive():
    for command in [
        "git restore file.txt",
        "git restore --worktree file.txt",
        "git restore --staged --worktree file.txt",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.matched_command == command
        assert report.reason == "git restore working tree"


def test_classify_shell_command_detects_git_force_checkout_as_destructive():
    for command in [
        "git checkout -f main",
        "git checkout --force main",
        "git switch -f main",
        "git switch --discard-changes main",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.matched_command == command
        assert report.reason == "git forced working tree checkout"


def test_classify_shell_command_detects_git_worktree_remove_as_destructive():
    for command in [
        "git worktree remove ../old-worktree",
        "git worktree remove --force ../old-worktree",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.matched_command == command
        assert report.reason == "git worktree remove"


def test_classify_shell_command_detects_git_stash_delete_as_destructive():
    cases = {
        "git stash drop stash@{0}": "git stash drop 'stash@{0}'",
        "git stash clear": "git stash clear",
    }
    for command, matched_command in cases.items():
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.matched_command == matched_command
        assert report.reason == "git stash delete"


def test_classify_shell_command_detects_git_reflog_delete_as_destructive():
    cases = {
        "git reflog delete HEAD@{1}": "git reflog delete 'HEAD@{1}'",
        "git reflog expire --expire=now --all": "git reflog expire --expire=now --all",
    }
    for command, matched_command in cases.items():
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.matched_command == matched_command
        assert report.reason == "git reflog delete"


def test_classify_shell_command_detects_git_object_prune_as_destructive():
    for command in [
        "git prune",
        "git gc --prune=now",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.matched_command == command
        assert report.reason == "git object prune"


def test_classify_shell_command_marks_git_remote_mutations_as_write():
    for command in [
        "git remote remove origin",
        "git remote set-url origin git@example.com:team/repo.git",
    ]:
        report = classify_shell_command(command)

        assert report.level == "write"
        assert report.matched_command == command
        assert report.reason == "git remote write"


def test_classify_shell_command_marks_git_push_as_write():
    report = classify_shell_command("git push origin main")

    assert report.level == "write"
    assert report.matched_command == "git push origin main"
    assert report.reason == "git remote write"


def test_classify_shell_command_detects_git_alias_shell_delete():
    report = classify_shell_command('git -c alias.x="!rm -rf /tmp/demo" x')

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_does_not_expand_git_alias_for_builtin_command():
    report = classify_shell_command('git -c alias.status="!rm -rf /tmp/demo" status')

    assert report.level == "readonly"
    assert report.matched_command == "git -c 'alias.status=!rm -rf /tmp/demo' status"
    assert "rm -rf /tmp/demo" not in report.commands


def test_classify_shell_command_does_not_expand_git_alias_for_other_builtin_command():
    report = classify_shell_command('git -c alias.config="!rm -rf /tmp/demo" config --get user.name')

    assert report.level == "write"
    assert report.matched_command == "git -c 'alias.config=!rm -rf /tmp/demo' config --get user.name"
    assert "rm -rf /tmp/demo" not in report.commands


def test_classify_shell_command_detects_eval_nested_delete():
    report = classify_shell_command("eval 'rm -rf /tmp/demo'")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert any(command.startswith("eval") for command in report.commands)


def test_classify_shell_command_detects_ifs_split_delete():
    report = classify_shell_command("rm${IFS}-rf${IFS}/tmp/demo")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"


def test_classify_shell_command_detects_bare_ifs_split_delete():
    report = classify_shell_command("rm$IFS-rf /tmp/demo")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"


def test_classify_shell_command_detects_eval_nested_connector_delete():
    report = classify_shell_command("eval 'echo ok; rm -rf /tmp/demo'")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"


def test_classify_shell_command_detects_command_substitution_delete():
    report = classify_shell_command("echo $(rm -rf /tmp/demo)")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"


def test_classify_shell_command_detects_backtick_substitution_delete():
    report = classify_shell_command("echo `rm -rf /tmp/demo`")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"


def test_classify_shell_command_detects_command_substitution_with_connector():
    report = classify_shell_command("echo $(echo ok; rm -rf /tmp/demo)")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"


def test_classify_shell_command_detects_remote_install_pipe_to_shell():
    report = classify_shell_command("curl -fsSL https://example.test/install.sh | bash")

    assert report.level == "destructive"
    assert report.matched_command == "curl -fsSL https://example.test/install.sh | bash"
    assert report.reason == "remote script piped to shell"


def test_classify_shell_command_detects_remote_install_pipe_to_sudo_shell():
    report = classify_shell_command("wget -qO- https://example.test/install.sh | sudo sh")

    assert report.level == "destructive"
    assert report.matched_command == "wget -qO- https://example.test/install.sh | sudo sh"
    assert report.reason == "remote script piped to shell"


def test_classify_shell_command_detects_base64_literal_pipe_to_shell():
    report = classify_shell_command("echo cm0gLXJmIC90bXAvZGVtbwo= | base64 -d | bash")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_base64_literal_command_substitution_to_shell():
    report = classify_shell_command('bash -c "$(echo cm0gLXJmIC90bXAvZGVtbwo= | base64 -d)"')

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_base64_literal_command_substitution_to_eval():
    report = classify_shell_command('eval "$(echo cm0gLXJmIC90bXAvZGVtbwo= | base64 -d)"')

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_remote_install_process_substitution_to_shell():
    report = classify_shell_command("bash <(curl -fsSL https://example.test/install.sh)")

    assert report.level == "destructive"
    assert report.matched_command == "bash <(curl -fsSL https://example.test/install.sh)"
    assert report.reason == "remote script process substitution to shell"


def test_classify_shell_command_detects_remote_install_process_substitution_to_source():
    report = classify_shell_command("source <(curl -fsSL https://example.test/install.sh)")

    assert report.level == "destructive"
    assert report.matched_command == "source <(curl -fsSL https://example.test/install.sh)"
    assert report.reason == "remote script process substitution to evaluator"


def test_classify_shell_command_detects_builtin_source_remote_install_process_substitution():
    report = classify_shell_command("builtin source <(curl -fsSL https://example.test/install.sh)")

    assert report.level == "destructive"
    assert report.matched_command == "source <(curl -fsSL https://example.test/install.sh)"
    assert report.reason == "remote script process substitution to evaluator"


def test_classify_shell_command_detects_remote_install_process_substitution_to_dot_source():
    report = classify_shell_command(". <(wget -qO- https://example.test/install.sh)")

    assert report.level == "destructive"
    assert report.matched_command == ". <(wget -qO- https://example.test/install.sh)"
    assert report.reason == "remote script process substitution to evaluator"


def test_classify_shell_command_detects_remote_install_command_substitution_to_shell():
    report = classify_shell_command('bash -c "$(curl -fsSL https://example.test/install.sh)"')

    assert report.level == "destructive"
    assert report.matched_command == 'bash -c "$(curl -fsSL https://example.test/install.sh)"'
    assert report.reason == "remote script command substitution to shell"


def test_classify_shell_command_detects_remote_install_command_substitution_to_eval():
    report = classify_shell_command('eval "$(curl -fsSL https://example.test/install.sh)"')

    assert report.level == "destructive"
    assert report.matched_command == 'eval "$(curl -fsSL https://example.test/install.sh)"'
    assert report.reason == "remote script command substitution to evaluator"


def test_classify_shell_command_detects_sudo_remote_install_command_substitution_to_shell():
    report = classify_shell_command('sudo sh -c "$(wget -qO- https://example.test/install.sh)"')

    assert report.level == "destructive"
    assert report.matched_command == 'sudo sh -c "$(wget -qO- https://example.test/install.sh)"'
    assert report.reason == "remote script command substitution to shell"


def test_classify_shell_command_detects_remote_install_here_string_to_shell():
    report = classify_shell_command('bash <<< "$(curl -fsSL https://example.test/install.sh)"')

    assert report.level == "destructive"
    assert report.matched_command == 'bash <<< "$(curl -fsSL https://example.test/install.sh)"'
    assert report.reason == "remote script redirected to shell stdin"


def test_classify_shell_command_detects_remote_install_heredoc_to_shell():
    command = "bash <<EOF\n$(curl -fsSL https://example.test/install.sh)\nEOF"
    report = classify_shell_command(command)

    assert report.level == "destructive"
    assert report.matched_command == command
    assert report.reason == "remote script redirected to shell stdin"


def test_classify_shell_command_detects_shell_heredoc_delete():
    report = classify_shell_command(
        "bash <<'EOF'\n"
        "echo ok\n"
        "rm -rf /tmp/demo\n"
        "EOF"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_shell_here_string_delete():
    report = classify_shell_command("bash <<< 'rm -rf /tmp/demo'")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_source_stdin_here_string_delete():
    report = classify_shell_command("source /dev/stdin <<< 'rm -rf /tmp/demo'")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_source_stdin_heredoc_delete():
    report = classify_shell_command(
        "source /dev/stdin <<'EOF'\n"
        "rm -rf /tmp/demo\n"
        "EOF"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_source_process_substitution_literal_delete():
    report = classify_shell_command("source <(echo 'rm -rf /tmp/demo')")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_builtin_source_process_substitution_literal_delete():
    report = classify_shell_command("builtin source <(echo 'rm -rf /tmp/demo')")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "source <(echo 'rm -rf /tmp/demo')" in report.commands
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_builtin_dot_process_substitution_literal_delete():
    report = classify_shell_command("builtin . <(echo 'rm -rf /tmp/demo')")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert ". <(echo 'rm -rf /tmp/demo')" in report.commands
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_shell_process_substitution_literal_delete():
    report = classify_shell_command("bash <(echo 'rm -rf /tmp/demo')")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_process_substitution_base64_literal_delete():
    report = classify_shell_command("bash <(echo cm0gLXJmIC90bXAvZGVtbwo= | base64 -d)")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_source_process_substitution_printf_literal_delete():
    report = classify_shell_command("source <(printf '%s\\n' 'rm -rf /tmp/demo')")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_source_process_substitution_printf_b_delete():
    report = classify_shell_command("source <(printf '%b' 'rm\\x20-rf /tmp/demo')")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_source_process_substitution_echo_escaped_newline_delete():
    report = classify_shell_command("source <(echo -e 'echo ok\\nrm -rf /tmp/demo')")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_powershell_remote_install_pipe_to_expression():
    report = classify_shell_command("irm https://example.test/install.ps1 | iex")

    assert report.level == "destructive"
    assert report.matched_command == "irm https://example.test/install.ps1 | iex"
    assert report.reason == "remote script piped to evaluator"


def test_classify_shell_command_detects_powershell_remove_item_as_destructive():
    report = classify_shell_command("Remove-Item -Recurse -Force C:\\Temp\\demo")

    assert report.level == "destructive"
    assert report.matched_command.startswith("Remove-Item ")
    assert report.reason == "file delete command"


def test_classify_shell_command_detects_powershell_command_delete():
    report = classify_shell_command('pwsh -Command "Remove-Item -Recurse -Force /tmp/demo"')

    assert report.level == "destructive"
    assert report.matched_command == "Remove-Item -Recurse -Force /tmp/demo"
    assert report.reason == "file delete command"
    assert "Remove-Item -Recurse -Force /tmp/demo" in report.commands


def test_classify_shell_command_detects_cmd_c_delete():
    report = classify_shell_command("cmd /c rd /s /q C:\\Temp\\demo")

    assert report.level == "destructive"
    assert report.reason == "file delete command"
    assert report.matched_command.startswith("rd ")


def test_classify_shell_command_detects_powershell_encoded_command_delete():
    report = classify_shell_command(
        "powershell -EncodedCommand "
        "UgBlAG0AbwB2AGUALQBJAHQAZQBtACAALQBSAGUAYwB1AHIAcwBlACAALQBGAG8AcgBjAGUAIAAvAHQAbQBwAC8AZABlAG0AbwA="
    )

    assert report.level == "destructive"
    assert report.matched_command == "Remove-Item -Recurse -Force /tmp/demo"
    assert report.reason == "file delete command"
    assert "Remove-Item -Recurse -Force /tmp/demo" in report.commands


def test_classify_shell_command_detects_powershell_stop_process_as_destructive():
    report = classify_shell_command("Stop-Process -Id 123 -Force")

    assert report.level == "destructive"
    assert report.matched_command == "Stop-Process -Id 123 -Force"
    assert report.reason == "process termination"


def test_classify_shell_command_detects_recursive_permission_change_as_destructive():
    report = classify_shell_command("chmod -R 777 /tmp/demo")

    assert report.level == "destructive"
    assert report.matched_command == "chmod -R 777 /tmp/demo"
    assert report.reason == "recursive permission change"


def test_classify_shell_command_detects_recursive_ownership_change_as_destructive():
    report = classify_shell_command("chown --recursive root:wheel /tmp/demo")

    assert report.level == "destructive"
    assert report.matched_command == "chown --recursive root:wheel /tmp/demo"
    assert report.reason == "recursive ownership change"


def test_classify_shell_command_marks_non_recursive_chmod_as_write():
    report = classify_shell_command("chmod +x scripts/run.sh")

    assert report.level == "write"
    assert report.reason == "unknown command"


def test_classify_shell_command_detects_device_redirection_as_destructive():
    report = classify_shell_command("echo data > /dev/sda")

    assert report.level == "destructive"
    assert report.matched_command == "echo data '>' /dev/sda"
    assert report.reason == "device redirection"


def test_classify_shell_command_detects_force_device_redirection_as_destructive():
    for command in [
        "echo data >| /dev/sda",
        "echo data 1>| /dev/sda",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.reason == "device redirection"


def test_classify_shell_command_detects_less_log_device_as_destructive():
    report = classify_shell_command("less -o /dev/sda input.txt")

    assert report.level == "destructive"
    assert report.reason == "device redirection"


def test_classify_shell_command_marks_dd_regular_output_as_write():
    report = classify_shell_command("dd if=/dev/zero of=out.img bs=1 count=1")

    assert report.level == "write"
    assert report.reason == "dd output file"


def test_classify_shell_command_detects_dd_device_output_as_destructive():
    report = classify_shell_command("dd if=/dev/zero of=/dev/sda bs=1 count=1")

    assert report.level == "destructive"
    assert report.reason == "dd device output"


def test_classify_shell_command_marks_tee_regular_output_as_write():
    report = classify_shell_command("echo data | tee out.txt")

    assert report.level == "write"
    assert report.reason == "tee output file"
    assert report.matched_command == "tee out.txt"


def test_classify_shell_command_detects_tee_device_output_as_destructive():
    report = classify_shell_command("echo data | tee -a /dev/sda")

    assert report.level == "destructive"
    assert report.reason == "tee device output"
    assert report.matched_command == "tee -a /dev/sda"


def test_classify_shell_command_marks_cp_regular_output_as_write():
    report = classify_shell_command("cp input.txt output.txt")

    assert report.level == "write"
    assert report.reason == "copy output file"


def test_classify_shell_command_detects_cp_device_output_as_destructive():
    report = classify_shell_command("cp image.iso /dev/sda")

    assert report.level == "destructive"
    assert report.reason == "copy device output"
    assert report.matched_command == "cp image.iso /dev/sda"


def test_classify_shell_command_marks_mv_regular_target_as_write():
    report = classify_shell_command("mv input.txt output.txt")

    assert report.level == "write"
    assert report.reason == "move target file"


def test_classify_shell_command_detects_mv_device_target_as_destructive():
    report = classify_shell_command("mv image.iso /dev/sda")

    assert report.level == "destructive"
    assert report.reason == "move device target"
    assert report.matched_command == "mv image.iso /dev/sda"


def test_classify_shell_command_marks_rsync_regular_target_as_write():
    report = classify_shell_command("rsync image.iso output.img")

    assert report.level == "write"
    assert report.reason == "rsync output target"


def test_classify_shell_command_detects_rsync_device_target_as_destructive():
    report = classify_shell_command("rsync --inplace image.iso /dev/sda")

    assert report.level == "destructive"
    assert report.reason == "rsync device target"
    assert report.matched_command == "rsync --inplace image.iso /dev/sda"


def test_classify_shell_command_marks_tar_regular_archive_output_as_write():
    report = classify_shell_command("tar -cf archive.tar file.txt")

    assert report.level == "write"
    assert report.reason == "tar archive output"


def test_classify_shell_command_detects_tar_device_archive_output_as_destructive():
    for command in [
        "tar -cf /dev/sda file.txt",
        "tar --create --file=/dev/sda file.txt",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.reason == "tar device output"


def test_classify_shell_command_marks_tar_extract_from_device_as_write():
    report = classify_shell_command("tar -xf /dev/sda")

    assert report.level == "write"
    assert report.reason != "tar device output"


def test_classify_shell_command_marks_install_regular_output_as_write():
    report = classify_shell_command("install input.txt output.txt")

    assert report.level == "write"
    assert report.reason == "install output file"


def test_classify_shell_command_detects_install_device_output_as_destructive():
    report = classify_shell_command("install image.iso /dev/sda")

    assert report.level == "destructive"
    assert report.reason == "install device output"
    assert report.matched_command == "install image.iso /dev/sda"


def test_classify_shell_command_marks_download_regular_output_as_write():
    for command in [
        "curl -o image.iso https://example.test/image.iso",
        "wget -O image.iso https://example.test/image.iso",
    ]:
        report = classify_shell_command(command)

        assert report.level == "write"
        assert report.reason == "download output file"


def test_classify_shell_command_detects_download_device_output_as_destructive():
    for command in [
        "curl -o /dev/sda https://example.test/image.iso",
        "wget -O /dev/sda https://example.test/image.iso",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.reason == "download device output"


def test_classify_shell_command_marks_openssl_regular_output_as_write():
    report = classify_shell_command("openssl enc -in image.iso -out encrypted.bin")

    assert report.level == "write"
    assert report.reason == "openssl output file"


def test_classify_shell_command_detects_openssl_device_output_as_destructive():
    report = classify_shell_command("openssl enc -in image.iso -out /dev/sda")

    assert report.level == "destructive"
    assert report.reason == "openssl device output"
    assert report.matched_command == "openssl enc -in image.iso -out /dev/sda"


def test_classify_shell_command_detects_mkfs_variant_as_destructive():
    report = classify_shell_command("mkfs.ext4 /dev/sda1")

    assert report.level == "destructive"
    assert report.matched_command == "mkfs.ext4 /dev/sda1"
    assert report.reason == "filesystem format command"


def test_classify_shell_command_detects_diskutil_destructive_subcommands():
    for command in [
        "diskutil eraseDisk APFS Demo /dev/disk2",
        "diskutil eraseVolume APFS Demo /dev/disk2s1",
        "diskutil partitionDisk /dev/disk2 GPT APFS Demo 100%",
        "diskutil secureErase 0 /dev/disk2",
        "diskutil zeroDisk /dev/disk2",
        "diskutil randomDisk /dev/disk2",
        "diskutil apfs deleteContainer disk1",
        "diskutil apfs deleteVolume disk1s1",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.reason == "diskutil destructive command"
        assert report.matched_command == command


def test_classify_shell_command_detects_macos_newfs_as_destructive():
    for command in [
        "newfs_msdos /dev/disk2s1",
        "newfs_apfs /dev/disk2s1",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.reason == "filesystem format command"
        assert report.matched_command == command


def test_classify_shell_command_detects_partition_table_writes_as_destructive():
    for command in [
        "fdisk -iy /dev/disk2",
        "gpt destroy /dev/disk2",
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.reason == "partition table destructive command"
        assert report.matched_command == command


def test_classify_shell_command_detects_format_command_as_destructive():
    report = classify_shell_command("format C:")

    assert report.level == "destructive"
    assert report.matched_command == "format C:"
    assert report.reason == "system destructive command"


def test_classify_shell_command_marks_regular_file_redirection_as_write():
    report = classify_shell_command("echo data > build.log")

    assert report.level == "write"
    assert report.reason == "output redirection"


def test_classify_shell_command_detects_python_inline_rmtree_as_destructive():
    report = classify_shell_command("python -c \"import shutil; shutil.rmtree('/tmp/demo')\"")

    assert report.level == "destructive"
    assert report.matched_command.startswith("python -c ")
    assert "shutil.rmtree" in report.matched_command
    assert report.reason == "python destructive file operation"


def test_classify_python_code_detects_rmtree_as_destructive():
    report = classify_python_code("import shutil\nshutil.rmtree('/tmp/demo')")

    assert report.level == "destructive"
    assert "shutil.rmtree" in report.matched_command
    assert report.reason == "python destructive file operation"


def test_classify_python_code_detects_device_write_as_destructive():
    report = classify_python_code("open('/dev/sda', 'w').write('x')")

    assert report.level == "destructive"
    assert "open" in report.matched_command
    assert report.reason == "python device write"


def test_classify_python_code_detects_os_system_nested_delete():
    report = classify_python_code("import os\nos.system('rm -rf /tmp/demo')")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_unlink_as_destructive():
    report = classify_shell_command("python3 -I -c \"import os; os.remove('/tmp/demo')\"")

    assert report.level == "destructive"
    assert report.matched_command.startswith("python3 -I -c ")
    assert "os.remove" in report.matched_command
    assert report.reason == "python destructive file operation"


def test_classify_shell_command_detects_python_inline_device_write_as_destructive():
    report = classify_shell_command("python -c \"open('/dev/sda', 'w').write('x')\"")

    assert report.level == "destructive"
    assert report.reason == "python device write"


def test_classify_shell_command_detects_path_python_inline_delete_as_destructive():
    report = classify_shell_command("./venv/bin/python3 -c \"import os; os.unlink('/tmp/demo')\"")

    assert report.level == "destructive"
    assert report.matched_command.startswith("./venv/bin/python3 -c ")
    assert "os.unlink" in report.matched_command
    assert report.reason == "python destructive file operation"


def test_classify_shell_command_detects_python_inline_shutil_alias_delete():
    report = classify_shell_command("python -c 'import shutil as s; s.rmtree(\"/tmp/demo\")'")

    assert report.level == "destructive"
    assert report.reason == "python destructive file operation"


def test_classify_shell_command_detects_python_inline_dunder_import_shutil_delete():
    report = classify_shell_command("python -c '__import__(\"shutil\").rmtree(\"/tmp/demo\")'")

    assert report.level == "destructive"
    assert report.reason == "python destructive file operation"


def test_classify_shell_command_detects_python_inline_exec_os_from_import_delete():
    report = classify_shell_command(
        "python -c 'exec(\"from os import unlink; unlink(\\\"/tmp/demo\\\")\")'"
    )

    assert report.level == "destructive"
    assert report.reason == "python destructive file operation"


def test_classify_shell_command_detects_python_inline_exec_compile_os_from_import_delete():
    report = classify_shell_command(
        "python -c 'exec(compile(\"from os import unlink; unlink(\\\"/tmp/demo\\\")\", \"<x>\", \"exec\"))'"
    )

    assert report.level == "destructive"
    assert report.reason == "python destructive file operation"


def test_classify_shell_command_detects_python_inline_assignment_os_from_import_delete():
    report = classify_shell_command(
        "python -c 'from os import unlink; delete = unlink; delete(\"/tmp/demo\")'"
    )

    assert report.level == "destructive"
    assert report.reason == "python destructive file operation"


def test_classify_shell_command_detects_python_inline_getattr_shutil_delete():
    report = classify_shell_command(
        "python -c 'import shutil; getattr(shutil, \"rmtree\")(\"/tmp/demo\")'"
    )

    assert report.level == "destructive"
    assert report.reason == "python destructive file operation"


def test_classify_shell_command_detects_python_inline_importlib_shutil_delete():
    report = classify_shell_command(
        "python -c 'import importlib as i; i.import_module(\"shutil\").rmtree(\"/tmp/demo\")'"
    )

    assert report.level == "destructive"
    assert report.reason == "python destructive file operation"


def test_classify_shell_command_detects_python_inline_assignment_shutil_delete():
    report = classify_shell_command(
        "python -c 'import shutil; rr = shutil.rmtree; rr(\"/tmp/demo\")'"
    )

    assert report.level == "destructive"
    assert report.reason == "python destructive file operation"


def test_classify_shell_command_detects_python_inline_os_from_import_delete():
    report = classify_shell_command("python -c 'from os import unlink; unlink(\"/tmp/demo\")'")

    assert report.level == "destructive"
    assert report.reason == "python destructive file operation"


def test_classify_shell_command_detects_python_inline_pathlib_alias_delete():
    report = classify_shell_command(
        "python -c 'from pathlib import Path as P; P(\"/tmp/demo\").unlink()'"
    )

    assert report.level == "destructive"
    assert report.reason == "python destructive file operation"


def test_classify_shell_command_detects_python_inline_getattr_pathlib_delete():
    report = classify_shell_command(
        "python -c 'from pathlib import Path; getattr(Path(\"/tmp/demo\"), \"unlink\")()'"
    )

    assert report.level == "destructive"
    assert report.reason == "python destructive file operation"


def test_classify_shell_command_detects_python_inline_assignment_pathlib_delete():
    report = classify_shell_command(
        "python -c 'from pathlib import Path; P = Path; P(\"/tmp/demo\").unlink()'"
    )

    assert report.level == "destructive"
    assert report.reason == "python destructive file operation"


def test_classify_shell_command_detects_python_inline_os_system_delete():
    report = classify_shell_command("python -c 'import os; os.system(\"rm -rf /tmp/demo\")'")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_node_inline_rm_sync_delete():
    report = classify_shell_command(
        'node -e "require(\\"fs\\").rmSync(\\"/tmp/demo\\", {recursive: true, force: true})"'
    )

    assert report.level == "destructive"
    assert report.reason == "node destructive file operation"
    assert "rmSync" in report.matched_command


def test_classify_shell_command_detects_node_inline_device_write_as_destructive():
    for command in [
        'node -e "require(\\"fs\\").writeFileSync(\\"/dev/sda\\", \\"x\\")"',
        'node -e "require(\\"fs\\").appendFileSync(\\"/dev/sda\\", \\"x\\")"',
        'node -e "require(\\"fs\\").createWriteStream(\\"/dev/sda\\")"',
    ]:
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.reason == "node device write"


def test_classify_shell_command_detects_python_heredoc_os_system_delete():
    report = classify_shell_command(
        "python - <<'PY'\n"
        "import os\n"
        "os.system(\"rm -rf /tmp/demo\")\n"
        "PY"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_heredoc_rmtree_delete():
    report = classify_shell_command(
        "python3 <<'PY'\n"
        "import shutil\n"
        "shutil.rmtree('/tmp/demo')\n"
        "PY"
    )

    assert report.level == "destructive"
    assert report.reason == "python destructive file operation"
    assert "shutil.rmtree" in report.matched_command


def test_classify_shell_command_detects_python_inline_dunder_import_os_system_delete():
    report = classify_shell_command("python -c '__import__(\"os\").system(\"rm -rf /tmp/demo\")'")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_getattr_os_system_delete():
    report = classify_shell_command(
        "python -c 'import os; getattr(os, \"system\")(\"rm -rf /tmp/demo\")'"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_assignment_os_system_delete():
    report = classify_shell_command(
        "python -c 'import os; f = os.system; f(\"rm -rf /tmp/demo\")'"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_importlib_os_system_delete():
    report = classify_shell_command(
        "python -c 'import importlib; importlib.import_module(\"os\").system(\"rm -rf /tmp/demo\")'"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_exec_os_system_delete():
    report = classify_shell_command(
        "python -c 'exec(\"import os; os.system(\\\"rm -rf /tmp/demo\\\")\")'"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_exec_compile_os_system_delete():
    report = classify_shell_command(
        "python -c 'exec(compile(\"import os; os.system(\\\"rm -rf /tmp/demo\\\")\", \"<x>\", \"exec\"))'"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_eval_os_system_delete():
    report = classify_shell_command(
        "python -c 'eval(\"__import__(\\\"os\\\").system(\\\"rm -rf /tmp/demo\\\")\")'"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_eval_compile_os_system_delete():
    report = classify_shell_command(
        "python -c 'eval(compile(\"__import__(\\\"os\\\").system(\\\"rm -rf /tmp/demo\\\")\", \"<x>\", \"eval\"))'"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_getattr_importlib_os_system_delete():
    report = classify_shell_command(
        "python -c 'import importlib; getattr(importlib.import_module(\"os\"), \"system\")(\"rm -rf /tmp/demo\")'"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_subprocess_list_delete():
    report = classify_shell_command(
        "python -c 'import subprocess; subprocess.run([\"rm\", \"-rf\", \"/tmp/demo\"])'"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_subprocess_keyword_list_delete():
    report = classify_shell_command(
        "python -c 'import subprocess; subprocess.run(args=[\"rm\", \"-rf\", \"/tmp/demo\"])'"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_subprocess_keyword_shell_delete():
    report = classify_shell_command(
        "python -c 'import subprocess; subprocess.run(args=\"rm -rf /tmp/demo\", shell=True)'"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_dunder_import_subprocess_delete():
    report = classify_shell_command(
        "python -c '__import__(\"subprocess\").run([\"rm\", \"-rf\", \"/tmp/demo\"])'"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_getattr_subprocess_delete():
    report = classify_shell_command(
        "python -c 'import subprocess; getattr(subprocess, \"run\")([\"rm\", \"-rf\", \"/tmp/demo\"])'"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_assignment_subprocess_delete():
    report = classify_shell_command(
        "python -c 'import subprocess; run = subprocess.run; run([\"rm\", \"-rf\", \"/tmp/demo\"])'"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_importlib_subprocess_delete():
    report = classify_shell_command(
        "python -c 'from importlib import import_module; import_module(\"subprocess\").run([\"rm\", \"-rf\", \"/tmp/demo\"])'"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_exec_subprocess_delete():
    report = classify_shell_command(
        "python -c 'exec(\"import subprocess; subprocess.run([\\\"rm\\\", \\\"-rf\\\", \\\"/tmp/demo\\\"])\")'"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_subprocess_alias_delete():
    report = classify_shell_command(
        "python -c 'import subprocess as sp; sp.run([\"rm\", \"-rf\", \"/tmp/demo\"])'"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_subprocess_sys_executable_delete():
    report = classify_shell_command(
        "python -c 'import subprocess,sys; subprocess.run([sys.executable, \"-c\", \"import os; os.system(\\\"rm -rf /tmp/demo\\\")\"])'"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_os_spawnlp_delete():
    report = classify_shell_command(
        "python -c 'import os; os.spawnlp(os.P_WAIT, \"rm\", \"rm\", \"-rf\", \"/tmp/demo\")'"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_os_execlp_delete():
    report = classify_shell_command(
        "python -c 'import os; os.execlp(\"rm\", \"rm\", \"-rf\", \"/tmp/demo\")'"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_os_posix_spawn_delete():
    report = classify_shell_command(
        "python -c 'import os; os.posix_spawn(\"/bin/rm\", [\"rm\", \"-rf\", \"/tmp/demo\"], {})'"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_python_inline_os_posix_spawnp_delete():
    report = classify_shell_command(
        "python -c 'import os; os.posix_spawnp(\"rm\", [\"rm\", \"-rf\", \"/tmp/demo\"], {})'"
    )

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_env_prefix_and_xargs_delete():
    report = classify_shell_command("PATH=/tmp/bin find . -name '*.pyc' -print0 | xargs -0 rm -f")

    assert report.level == "destructive"
    assert report.env_prefixes == {"PATH": "/tmp/bin"}
    assert report.reason in {"find delete pipeline", "xargs rm"}


def test_classify_shell_command_detects_find_exec_delete():
    report = classify_shell_command("find . -name '*.tmp' -exec rm -rf {} +")

    assert report.level == "destructive"
    assert report.reason == "find exec rm"
    assert report.matched_command == "rm -rf {}"
    assert "rm -rf {}" in report.commands


def test_classify_shell_command_detects_find_ok_delete():
    report = classify_shell_command("find . -name '*.tmp' -ok rm -rf {} \\;")

    assert report.level == "destructive"
    assert report.reason == "find exec rm"
    assert report.matched_command == "rm -rf {}"
    assert "rm -rf {}" in report.commands


def test_classify_shell_command_detects_find_okdir_delete():
    report = classify_shell_command("find . -name '*.tmp' -okdir rm -rf {} +")

    assert report.level == "destructive"
    assert report.reason == "find exec rm"
    assert report.matched_command == "rm -rf {}"
    assert "rm -rf {}" in report.commands


def test_classify_shell_command_detects_find_exec_nested_shell_delete():
    report = classify_shell_command("find . -name '*.tmp' -exec sh -c 'rm -rf \"$1\"' sh {} +")

    assert report.level == "destructive"
    assert report.reason == "rm recursive force"
    assert report.matched_command == "rm -rf '$1'"
    assert "rm -rf '$1'" in report.commands


def test_classify_shell_command_detects_xargs_nested_shell_delete():
    report = classify_shell_command("printf '%s\n' . | xargs -I{} sh -c 'rm -rf \"$1\"' sh {}")

    assert report.level == "destructive"
    assert report.reason == "rm recursive force"
    assert report.matched_command == "rm -rf '$1'"
    assert "rm -rf '$1'" in report.commands


def test_classify_shell_command_detects_env_wrapper_prefix():
    report = classify_shell_command("env PATH=/tmp/hijack git status --short")

    assert report.level == "readonly"
    assert report.env_prefixes == {"PATH": "/tmp/hijack"}
    assert report.matched_command == "git status --short"


def test_classify_shell_command_detects_env_split_string_nested_delete():
    report = classify_shell_command("env -S 'rm -rf /tmp/demo'")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_env_split_string_sudo_option_delete():
    report = classify_shell_command("env -S sudo -Eu root rm -rf /tmp/demo")

    assert report.level == "destructive"
    assert report.matched_command == "rm -rf /tmp/demo"
    assert report.reason == "rm recursive force"
    assert "sudo -Eu root rm -rf /tmp/demo" in report.commands
    assert "rm -rf /tmp/demo" in report.commands


def test_classify_shell_command_detects_env_split_string_prefix():
    report = classify_shell_command("env -S 'PATH=/tmp/hijack git status --short'")

    assert report.level == "readonly"
    assert report.env_prefixes == {"PATH": "/tmp/hijack"}
    assert report.matched_command == "git status --short"


def test_classify_shell_command_strips_safe_wrappers():
    report = classify_shell_command("time nice git status --short")

    assert report.level == "readonly"
    assert report.matched_command == "git status --short"


def test_classify_shell_command_strips_safe_wrapper_option_values():
    nice_report = classify_shell_command("nice -n 10 git status --short")
    env_report = classify_shell_command("env -u PYTHONPATH PATH=/tmp/hijack git status --short")

    assert nice_report.level == "readonly"
    assert nice_report.matched_command == "git status --short"
    assert env_report.level == "readonly"
    assert env_report.env_prefixes == {"PATH": "/tmp/hijack"}
    assert env_report.matched_command == "git status --short"


def test_classify_shell_command_strips_process_wrappers_before_delete():
    for command in (
        "timeout 5 rm -rf /tmp/demo",
        "nohup rm -rf /tmp/demo",
        "setsid rm -rf /tmp/demo",
        "stdbuf -oL rm -rf /tmp/demo",
    ):
        report = classify_shell_command(command)

        assert report.level == "destructive"
        assert report.reason == "rm recursive force"
        assert report.matched_command == "rm -rf /tmp/demo"


def test_classify_shell_command_strips_safe_wrapper_long_option_equals_values():
    report = classify_shell_command("env --chdir=/tmp PATH=/tmp/hijack git status --short")

    assert report.level == "readonly"
    assert report.env_prefixes == {"PATH": "/tmp/hijack"}
    assert report.matched_command == "git status --short"


def test_classify_shell_command_marks_unknown_write_as_write():
    report = classify_shell_command("python build.py")

    assert report.level == "write"
    assert report.reason == "unknown command"


def test_classify_shell_command_fails_closed_for_unparseable_shell():
    report = classify_shell_command("echo 'unterminated")

    assert report.level == "write"
    assert report.reason == "unparseable command"
    assert report.matched_command == "echo 'unterminated"
