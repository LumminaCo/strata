# 0004. Orchestrate Compose from the host wrappers

Accepted for the M0 implementation.

The Bash and PowerShell wrappers invoke Compose on the host to start, wait for, and stop services. They run recipes inside the development container for compilation, seeding, packaging, and test commands. This keeps Docker daemon access on the host and preserves Docker and Git as the development prerequisites.
