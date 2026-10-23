@echo off
set PYTHONPATH=%~dp0tools;%PYTHONPATH%
python -m hx %*
