const { createClient } = require("@supabase/supabase-js");
const jwt = require("jsonwebtoken");

const requiredEnvVars = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "JWT_SECRET"];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

function extractBearerToken(authorizationHeader) {
  if (!authorizationHeader) {
    return null;
  }

  const [scheme, token] = authorizationHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token;
}

async function verifyAuthToken(authorizationHeader) {
  const token = extractBearerToken(authorizationHeader);

  if (!token) {
    const error = new Error("Missing or invalid Authorization header");
    error.statusCode = 401;
    throw error;
  }

  try {
    jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"]
    });
  } catch (jwtError) {
    const error = new Error("Invalid or expired token");
    error.statusCode = 401;
    throw error;
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    const authError = new Error("Unable to verify Supabase user");
    authError.statusCode = 401;
    throw authError;
  }

  return data.user;
}

module.exports = {
  supabase,
  verifyAuthToken
};
