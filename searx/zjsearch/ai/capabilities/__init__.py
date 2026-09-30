# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The cross-feature CAPABILITIES of the AI layer -- the plugin shelf.

A capability is a service any feature composes, independent of which
feature introduced it: :py:mod:`.images` turns client image references
into multimodal content parts (the AI Overview attaches them today;
any multimodal feature composes the same call), :py:mod:`.reader` is
the page reader the ``web_reader`` tool speaks through.  Capabilities
are feature-agnostic by contract: their entry points take the request
payload / explicit arguments, never a feature's module.
"""
