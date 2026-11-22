
# Security Policy

## Project Security Commitment

Cetus 3 is an open-source WebAssembly analysis and modification tool.

The maintainer's security objective is to ensure that the extension behaves as documented and does not intentionally compromise the security, privacy, or data of its users.

Cetus 3 is not designed to collect personal information, steal credentials, transmit private user data, or perform undisclosed malicious actions.

## Scope

Security issues relevant to this project include:

- Unauthorized collection or transmission of user data.
- Credential or sensitive information exposure.
- Unexpected network communication.
- Malicious or undisclosed code execution.
- Extension permission abuse.
- Vulnerabilities affecting browser security or user privacy.
- Unintended access to data outside the intended scope of the extension.

## Intended Functionality

Cetus 3 intentionally provides functionality that can inspect and modify WebAssembly applications, including:

- Reading and modifying WebAssembly memory.
- Patching WebAssembly binaries.
- Inspecting functions and execution flow.
- Executing user-provided scripts.
- Modifying application behavior through debugging tools.

These operations are core features of the extension and are not considered security vulnerabilities by themselves.

Users are responsible for scripts they execute and modifications they apply to third-party applications.

## Reporting Vulnerabilities

Please do not disclose security vulnerabilities through public GitHub Issues.

Use GitHub's private vulnerability reporting feature, if enabled, or contact the maintainer privately through GitHub.

Include reproduction steps, impact, and any relevant technical details.

## Supported Versions

Security fixes are primarily provided for the latest stable release.

Older versions may not receive security updates.
