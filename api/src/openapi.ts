// OpenAPI description of the public API (lead ingestion and inbound webhooks), served at
// /api/openapi.json and rendered at /developers. The app's internal routes are not part of it.
export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'LeadFlow AI public API',
    version: '1.0.0',
    description:
      'Send leads into a client workspace from any form, landing page or ad platform, and receive CRM events. Each client has its own API key (Settings → API). This is a demo: data lives in your own sandbox.',
  },
  servers: [{ url: '/api' }],
  components: {
    securitySchemes: { clientKey: { type: 'http', scheme: 'bearer', description: "A client workspace's API key, e.g. lf_live_…" } },
    schemas: {
      NewLead: {
        type: 'object',
        required: ['first_name'],
        properties: {
          first_name: { type: 'string', maxLength: 80 },
          last_name: { type: 'string', maxLength: 80 },
          email: { type: 'string', format: 'email', description: 'Email or phone is required.' },
          phone: { type: 'string', maxLength: 40 },
          company: { type: 'string', maxLength: 120 },
          postcode: { type: 'string', maxLength: 12 },
          message: { type: 'string', maxLength: 2000 },
          answers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Form questions and answers, up to 12.' },
          source: { type: 'string', enum: ['meta', 'google', 'tiktok', 'linkedin', 'email', 'organic', 'referral'] },
          utm_campaign: { type: 'string', description: "Matches a campaign's UTM code to attribute the lead." },
        },
      },
      Error: { type: 'object', properties: { error: { type: 'string' } } },
    },
  },
  paths: {
    '/v1/leads': {
      post: {
        summary: 'Create a lead',
        description: 'Stores the lead, runs "lead created" automations, then qualifies it with AI in the background and runs "lead qualified" automations.',
        security: [{ clientKey: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/NewLead' },
              example: {
                first_name: 'Helen',
                last_name: 'Ward',
                phone: '07700 900123',
                postcode: 'SK4 3BT',
                utm_campaign: 'winter-energy-bills',
                answers: { Homeowner: 'Yes', 'Monthly electricity bill': '£150-£250', Timeline: 'Within 3 months' },
                message: 'Want panels and a battery before spring. Is finance available?',
              },
            },
          },
        },
        responses: {
          '201': { description: 'Created', content: { 'application/json': { example: { id: 'b3c1…', status: 'received', qualification: 'pending' } } } },
          '401': { description: 'Missing or invalid API key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '422': { description: 'Validation failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '429': { description: 'More than 60 leads a minute for this client' },
        },
      },
    },
    '/v1/webhooks/ghl': {
      post: {
        summary: 'Receive a GoHighLevel event',
        description:
          'Verifies the x-leadflow-signature header (sha256=HMAC of the raw body), ignores events already received (by webhookId), and attaches InboundMessage replies to the matching lead. Real GHL webhooks are verified against GHL\'s public key instead; the demo signs with a shared secret.',
        parameters: [{ name: 'x-leadflow-signature', in: 'header', required: true, schema: { type: 'string', example: 'sha256=3f9a…' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              example: { type: 'InboundMessage', webhookId: 'evt_123', locationId: 'loc_brightside_ab12cd34', contactId: 'Xy12…', messageType: 'SMS', body: 'Thursday works' },
            },
          },
        },
        responses: { '202': { description: 'Accepted' }, '200': { description: 'Duplicate, already processed' }, '401': { description: 'Bad signature' } },
      },
    },
    '/health': { get: { summary: 'Health check', responses: { '200': { description: 'OK' } } } },
  },
} as const;
