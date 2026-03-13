/**
 * Canonical tech taxonomy.
 * Each entry: { canonical, category, aliases[] }
 * Aliases are lowercase for matching. The normalizer maps any alias → canonical name.
 */
export const TECH_TAXONOMY = [
  // --- Frontend frameworks ---
  { canonical: 'React', category: 'frontend', aliases: ['react', 'reactjs', 'react.js', 'react js', 'react/redux', 'react hooks'] },
  { canonical: 'Vue.js', category: 'frontend', aliases: ['vue', 'vuejs', 'vue.js', 'vue 3', 'vue 2', 'nuxt', 'nuxtjs'] },
  { canonical: 'Angular', category: 'frontend', aliases: ['angular', 'angularjs', 'angular.js', 'angular 2+', 'angular2', 'ng'] },
  { canonical: 'Next.js', category: 'frontend', aliases: ['next.js', 'nextjs', 'next js'] },
  { canonical: 'Svelte', category: 'frontend', aliases: ['svelte', 'sveltekit', 'svelte kit'] },
  { canonical: 'TypeScript', category: 'language', aliases: ['typescript', 'ts', 'tsx'] },
  { canonical: 'JavaScript', category: 'language', aliases: ['javascript', 'js', 'es6', 'es2015', 'ecmascript', 'vanilla js', 'node.js', 'nodejs', 'node js'] },

  // --- Backend frameworks ---
  { canonical: 'Django', category: 'backend', aliases: ['django', 'django rest framework', 'drf', 'django rest'] },
  { canonical: 'FastAPI', category: 'backend', aliases: ['fastapi', 'fast api'] },
  { canonical: 'Flask', category: 'backend', aliases: ['flask'] },
  { canonical: 'Express.js', category: 'backend', aliases: ['express', 'expressjs', 'express.js', 'express js'] },
  { canonical: 'NestJS', category: 'backend', aliases: ['nestjs', 'nest.js', 'nest js'] },
  { canonical: 'Ruby on Rails', category: 'backend', aliases: ['rails', 'ruby on rails', 'ror', 'ruby/rails', 'rails api'] },
  { canonical: 'Laravel', category: 'backend', aliases: ['laravel', 'php laravel'] },
  { canonical: 'Spring Boot', category: 'backend', aliases: ['spring boot', 'spring', 'spring framework', 'spring mvc'] },
  { canonical: 'Go', category: 'language', aliases: ['golang', 'go', 'go lang'] },
  { canonical: 'Rust', category: 'language', aliases: ['rust', 'rust lang', 'rustlang'] },
  { canonical: 'Python', category: 'language', aliases: ['python', 'python3', 'python 3', 'python2', 'py'] },
  { canonical: 'Java', category: 'language', aliases: ['java', 'java 8', 'java 11', 'java 17', 'java 21'] },
  { canonical: 'Kotlin', category: 'language', aliases: ['kotlin', 'kotlin jvm'] },
  { canonical: 'Scala', category: 'language', aliases: ['scala', 'scala/akka'] },
  { canonical: 'PHP', category: 'language', aliases: ['php', 'php 8', 'php7', 'php8'] },
  { canonical: 'C#', category: 'language', aliases: ['c#', 'csharp', 'c sharp', '.net', 'dotnet', 'asp.net', 'aspnet'] },
  { canonical: 'Elixir', category: 'language', aliases: ['elixir', 'phoenix', 'elixir/phoenix'] },
  { canonical: 'Clojure', category: 'language', aliases: ['clojure', 'clojurescript'] },

  // --- Databases ---
  { canonical: 'PostgreSQL', category: 'database', aliases: ['postgres', 'postgresql', 'pg', 'psql'] },
  { canonical: 'MySQL', category: 'database', aliases: ['mysql', 'mariadb', 'maria db'] },
  { canonical: 'MongoDB', category: 'database', aliases: ['mongodb', 'mongo', 'mongo db'] },
  { canonical: 'Redis', category: 'database', aliases: ['redis', 'redis cache', 'redis cluster'] },
  { canonical: 'Elasticsearch', category: 'database', aliases: ['elasticsearch', 'elastic search', 'opensearch', 'open search'] },
  { canonical: 'Cassandra', category: 'database', aliases: ['cassandra', 'apache cassandra'] },
  { canonical: 'DynamoDB', category: 'database', aliases: ['dynamodb', 'dynamo', 'aws dynamodb'] },
  { canonical: 'Snowflake', category: 'database', aliases: ['snowflake', 'snowflake db'] },
  { canonical: 'BigQuery', category: 'database', aliases: ['bigquery', 'big query', 'google bigquery'] },
  { canonical: 'ClickHouse', category: 'database', aliases: ['clickhouse', 'click house'] },

  // --- Cloud & infra ---
  { canonical: 'AWS', category: 'cloud', aliases: ['aws', 'amazon web services', 'amazon aws', 'aws cloud'] },
  { canonical: 'GCP', category: 'cloud', aliases: ['gcp', 'google cloud', 'google cloud platform'] },
  { canonical: 'Azure', category: 'cloud', aliases: ['azure', 'microsoft azure', 'ms azure'] },
  { canonical: 'Kubernetes', category: 'infrastructure', aliases: ['kubernetes', 'k8s', 'k 8s', 'kube'] },
  { canonical: 'Docker', category: 'infrastructure', aliases: ['docker', 'docker containers', 'docker compose', 'containerization'] },
  { canonical: 'Terraform', category: 'infrastructure', aliases: ['terraform', 'terraform cloud', 'tf'] },
  { canonical: 'Helm', category: 'infrastructure', aliases: ['helm', 'helm charts'] },

  // --- Data & ML ---
  { canonical: 'Apache Spark', category: 'data', aliases: ['spark', 'apache spark', 'pyspark', 'spark sql'] },
  { canonical: 'Apache Kafka', category: 'data', aliases: ['kafka', 'apache kafka', 'kafka streams'] },
  { canonical: 'Airflow', category: 'data', aliases: ['airflow', 'apache airflow'] },
  { canonical: 'dbt', category: 'data', aliases: ['dbt', 'data build tool'] },
  { canonical: 'PyTorch', category: 'ml', aliases: ['pytorch', 'torch'] },
  { canonical: 'TensorFlow', category: 'ml', aliases: ['tensorflow', 'tf', 'keras'] },
  { canonical: 'scikit-learn', category: 'ml', aliases: ['scikit-learn', 'sklearn', 'scikit learn'] },

  // --- Observability ---
  { canonical: 'Datadog', category: 'observability', aliases: ['datadog', 'data dog'] },
  { canonical: 'New Relic', category: 'observability', aliases: ['new relic', 'newrelic'] },
  { canonical: 'Grafana', category: 'observability', aliases: ['grafana', 'grafana labs'] },
  { canonical: 'Prometheus', category: 'observability', aliases: ['prometheus', 'prom'] },
  { canonical: 'Sentry', category: 'observability', aliases: ['sentry', 'sentry.io'] },
  { canonical: 'PagerDuty', category: 'observability', aliases: ['pagerduty', 'pager duty'] },

  // --- Messaging & queues ---
  { canonical: 'RabbitMQ', category: 'messaging', aliases: ['rabbitmq', 'rabbit mq', 'rabbit'] },
  { canonical: 'SQS', category: 'messaging', aliases: ['sqs', 'aws sqs', 'amazon sqs'] },
  { canonical: 'Celery', category: 'messaging', aliases: ['celery', 'celery worker'] },

  // --- CI/CD ---
  { canonical: 'GitHub Actions', category: 'cicd', aliases: ['github actions', 'gh actions', 'gha'] },
  { canonical: 'Jenkins', category: 'cicd', aliases: ['jenkins', 'jenkins ci', 'jenkinsfile'] },
  { canonical: 'CircleCI', category: 'cicd', aliases: ['circleci', 'circle ci'] },
  { canonical: 'GitLab CI', category: 'cicd', aliases: ['gitlab ci', 'gitlab ci/cd', '.gitlab-ci'] },

  // --- Auth & identity ---
  { canonical: 'Auth0', category: 'auth', aliases: ['auth0', 'auth 0'] },
  { canonical: 'Okta', category: 'auth', aliases: ['okta', 'okta sso'] },
  { canonical: 'Keycloak', category: 'auth', aliases: ['keycloak', 'key cloak'] },

  // --- Payments ---
  { canonical: 'Stripe', category: 'payments', aliases: ['stripe', 'stripe api', 'stripe payments'] },
  { canonical: 'Braintree', category: 'payments', aliases: ['braintree', 'brain tree'] },

  // --- CRM & sales ---
  { canonical: 'Salesforce', category: 'crm', aliases: ['salesforce', 'sfdc', 'salesforce crm'] },
  { canonical: 'HubSpot', category: 'crm', aliases: ['hubspot', 'hub spot'] },
];

// Build lookup map: lowercase alias → { canonical, category }
export const ALIAS_MAP = new Map();
for (const tech of TECH_TAXONOMY) {
  for (const alias of tech.aliases) {
    ALIAS_MAP.set(alias.toLowerCase(), { canonical: tech.canonical, category: tech.category });
  }
}

// All canonical names as a set for fast lookup
export const CANONICAL_SET = new Set(TECH_TAXONOMY.map(t => t.canonical));
