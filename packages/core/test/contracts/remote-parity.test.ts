import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  runRetrievalConformance,
} from "../../src/contracts/conformance/retrieval";
import { PortError } from "../../src/contracts/ports";
import {
  decodeRemoteValue,
  RemotePortClient,
  connectRemotePort,
} from "../../src/contracts/remote";
import {
  RETRIEVAL_FIXTURES,
  temporaryPortContext,
} from "./fixtures";
import type {
  RemoteRetrievalFixture,
} from "./remote-fixture";
import {
  startRemoteRetrievalFixture,
} from "./remote-fixture";

describe("remote port parity", () => {
  let remote: RemoteRetrievalFixture;

  beforeAll(async () => {
    remote = await startRemoteRetrievalFixture();
  });

  afterAll(async () => {
    await remote.stop();
  });

  test("the loopback adapter passes the same conformance suite as the in-process port", async () => {
    const report = await runRetrievalConformance({
      descriptor: remote.descriptor,
      create: remote.create,
      destroy: async (port) => port.close(),
      fixtures: RETRIEVAL_FIXTURES,
    });

    expect(report).toEqual({
      pass: true,
      failures: [],
      families: {
        identity: "pass",
        isolation: "pass",
        idempotence: "pass",
        failure_shape: "pass",
        restart: "pass",
        deletion: "pass",
      },
    });

    const temporary = temporaryPortContext(remote.descriptor);
    try {
      const client = await connectRemotePort(temporary.ctx, remote.options);
      const input = new Float32Array([0.25, -1.5, 42]);
      const echoed = await client.invoke<Float32Array>("echo", [input]);
      expect(echoed).toBeInstanceOf(Float32Array);
      expect([...echoed]).toEqual([...input]);
      await client.close();
    } finally {
      temporary.cleanup();
    }
  });

  test("the adapter refuses a non-loopback host", () => {
    const temporary = temporaryPortContext(remote.descriptor);
    try {
      expect(
        () =>
          new RemotePortClient(temporary.ctx, {
            ...remote.options,
            endpoint: {
              transport: "tcp",
              host: "192.0.2.10",
              port: 3210,
            },
          }),
      ).toThrow(PortError);
      try {
        new RemotePortClient(temporary.ctx, {
          ...remote.options,
          endpoint: {
            transport: "tcp",
            host: "example.invalid",
            port: 3210,
          },
        });
      } catch (error) {
        expect(error).toBeInstanceOf(PortError);
        expect((error as PortError).code).toBe("config_invalid");
      }
    } finally {
      temporary.cleanup();
    }
  });

  test("an adapter timeout maps to a retryable port error", async () => {
    const temporary = temporaryPortContext(remote.descriptor);
    try {
      const client = await connectRemotePort(temporary.ctx, remote.options);
      try {
        await client.invoke("wait", [50]);
        throw new Error("expected wait to time out");
      } catch (error) {
        expect(error).toBeInstanceOf(PortError);
        expect((error as PortError).code).toBe("timeout");
        expect((error as PortError).retryable).toBe(true);
      } finally {
        await client.close();
      }
    } finally {
      temporary.cleanup();
    }
  });

  test("the adapter fails closed when the bearer secret is wrong", async () => {
    const temporary = temporaryPortContext(
      remote.descriptor,
      async () => "wrong-synthetic-token",
    );
    try {
      try {
        await connectRemotePort(temporary.ctx, remote.options);
        throw new Error("expected authentication to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(PortError);
        expect((error as PortError).code).toBe("unavailable");
        expect((error as Error).message).not.toContain(
          "wrong-synthetic-token",
        );
      }
    } finally {
      temporary.cleanup();
    }
  });

  test("malformed Float32Array framing is refused", () => {
    const malformed = {
      $type: "Float32Array",
      base64: Buffer.from([0, 1, 2]).toString("base64"),
    };
    expect(() => decodeRemoteValue(malformed)).toThrow(PortError);
    try {
      decodeRemoteValue(malformed);
    } catch (error) {
      expect((error as PortError).code).toBe("config_invalid");
    }
  });
});
