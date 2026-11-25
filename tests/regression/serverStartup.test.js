const mockServer = { on: jest.fn(), close: jest.fn() };
const mockApp = { listen: jest.fn() };
const mockDatabase = { connect: jest.fn().mockResolvedValue(), disconnect: jest.fn().mockResolvedValue() };
const mockQa = {
  start: jest.fn(),
  stopWorkers: jest.fn().mockResolvedValue(),
  stop: jest.fn().mockResolvedValue()
};
jest.mock('../../src/app', () => mockApp);
jest.mock('../../src/utils/database', () => mockDatabase);
jest.mock('../../src/warehouseQa/runtime', () => mockQa);

let on, previousPort, previousHost;
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  on = jest.spyOn(process, 'on').mockImplementation(() => process);
  previousPort = process.env.PORT;
  previousHost = process.env.HOST;
  process.env.PORT = '3019';
  delete process.env.HOST;
  mockApp.listen.mockImplementation((_port, _host, callback) => {
    callback();
    return mockServer;
  });
});
afterEach(() => {
  on.mockRestore();
  if (previousPort === undefined) delete process.env.PORT;
  else process.env.PORT = previousPort;
  if (previousHost === undefined) delete process.env.HOST;
  else process.env.HOST = previousHost;
});

test.each([undefined, '127.0.0.1'])('production startup preserves timeouts and binds host %s', (host) => {
  if (host) process.env.HOST = host;
  require('../../index');
  expect(mockDatabase.connect).toHaveBeenCalledTimes(1);
  expect(mockApp.listen).toHaveBeenCalledWith('3019', host || '0.0.0.0', expect.any(Function));
  expect(mockServer).toMatchObject({ timeout: 115000, keepAliveTimeout: 115000, headersTimeout: 120000 });
  expect(mockServer.on).toHaveBeenCalledWith('error', expect.any(Function));
  expect(mockQa.start).toHaveBeenCalledWith(expect.any(Function));
});

test('shutdown stops claiming but keeps database pools open until in-flight HTTP transactions finish', async () => {
  const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
  let finishRequests;
  mockServer.close.mockImplementation((callback) => {
    finishRequests = callback;
  });
  try {
    require('../../index');
    const shutdown = on.mock.calls.find(([name]) => name === 'SIGTERM')[1];
    const closing = shutdown('SIGTERM');
    await Promise.resolve();
    expect(mockQa.stopWorkers).toHaveBeenCalledTimes(1);
    expect(mockQa.stop).not.toHaveBeenCalled();
    expect(mockDatabase.disconnect).not.toHaveBeenCalled();
    await shutdown('SIGTERM');
    expect(mockServer.close).toHaveBeenCalledTimes(1);
    finishRequests();
    await closing;
    expect(mockQa.stop).toHaveBeenCalledTimes(1);
    expect(mockDatabase.disconnect).toHaveBeenCalledTimes(1);
    expect(mockQa.stop.mock.invocationCallOrder[0]).toBeLessThan(
      mockDatabase.disconnect.mock.invocationCallOrder[0]
    );
    expect(exit).toHaveBeenCalledWith(0);
  } finally {
    exit.mockRestore();
  }
});
