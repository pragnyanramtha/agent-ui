#!/usr/bin/env python3
"""Runs a command on a pseudo-terminal and relays it over pipes.

stdin -> terminal input, terminal output -> stdout, and fd 3 carries
"<cols> <rows>\n" resize lines. Used by server/pty.mjs so the web terminal
needs no native Node module."""

import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

cmd = sys.argv[1:]
cols = int(os.environ.pop("PTY_COLS", "100"))
rows = int(os.environ.pop("PTY_ROWS", "30"))

pid, fd = pty.fork()
if pid == 0:
    try:
        os.execvp(cmd[0], cmd)
    except BaseException as err:  # noqa: BLE001 - say why on the terminal, then exit like a shell would
        try:
            os.write(1, f"couldn't run {cmd[0]}: {getattr(err, 'strerror', None) or err}\r\n".encode())
        except BaseException:  # noqa: BLE001
            pass
    finally:
        os._exit(127)


def set_size(c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", max(r, 1), max(c, 1), 0, 0))
    try:
        os.kill(pid, signal.SIGWINCH)
    except ProcessLookupError:
        pass


def write_all(target, data):
    while data:
        data = data[os.write(target, data):]


set_size(cols, rows)
CTL = 3
watch = [0, fd, CTL]
pending = b""
try:
    while True:
        ready, _, _ = select.select(watch, [], [])
        if fd in ready:
            try:
                out = os.read(fd, 65536)
            except OSError:
                break
            if not out:
                break
            write_all(1, out)
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:
                break
            write_all(fd, data)
        if CTL in ready:
            data = os.read(CTL, 1024)
            if not data:
                watch.remove(CTL)
                continue
            pending += data
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                parts = line.split()
                if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
                    set_size(int(parts[0]), int(parts[1]))
finally:
    status = None
    try:
        done, status = os.waitpid(pid, os.WNOHANG)
        if not done:
            try:
                os.kill(pid, signal.SIGHUP)
            except ProcessLookupError:
                pass
            _, status = os.waitpid(pid, 0)
    except ChildProcessError:
        status = None


def exit_code(st):
    if hasattr(os, "waitstatus_to_exitcode"):  # Python 3.9+
        code = os.waitstatus_to_exitcode(st)
        return 128 - code if code < 0 else code
    if os.WIFSIGNALED(st):
        return 128 + os.WTERMSIG(st)
    return os.WEXITSTATUS(st) if os.WIFEXITED(st) else 1


sys.exit(0 if status is None else exit_code(status))
