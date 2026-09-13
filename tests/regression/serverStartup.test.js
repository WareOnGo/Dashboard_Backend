const mockServer = { on: jest.fn() };
const mockApp = { listen: jest.fn(() => mockServer) };
const mockDatabase = { connect: jest.fn().mockResolvedValue(), disconnect: jest.fn().mockResolvedValue() };
jest.mock('../../src/app', () => mockApp);
jest.mock('../../src/utils/database', () => mockDatabase);

test('the production entrypoint connects the database and starts the HTTP server with its existing timeouts', () => {
  const on = jest.spyOn(process, 'on').mockImplementation(() => process);
  const previousPort = process.env.PORT;
  process.env.PORT = '3019';
  try {
    require('../../index');
    expect(mockDatabase.connect).toHaveBeenCalledTimes(1);
    expect(mockApp.listen).toHaveBeenCalledWith('3019', expect.any(Function));
    expect(mockServer).toMatchObject({ timeout: 115000, keepAliveTimeout: 115000, headersTimeout: 120000 });
    expect(mockServer.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  } finally {
    on.mockRestore();
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
});
