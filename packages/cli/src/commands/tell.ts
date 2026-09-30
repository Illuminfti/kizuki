import { CorrectError, OWNER, correct, isWorldWireToken, serveCorrect } from "@kizuki/core";
import type { CorrectArgs, WorldReadResult } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { withVault } from "../context";
import { tryRefreshDerived } from "../derived";
import { clean, jsonEnvelope } from "../output";
import { RESPONSE_CONTRACT_BOUND, RESPONSE_CONTRACT_OPTION, cliResultV2, contractFailure, responseContract, serveV2 } from "../response-contract";
import type { CorrectData } from "@kizuki/core";
