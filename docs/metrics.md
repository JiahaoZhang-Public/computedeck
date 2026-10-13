# Reading the numbers

- **GPUs in use** counts GPUs allocated to your running jobs and running cloud instances. For SSH GPU machines it counts GPUs with compute processes; unavailable process visibility remains unknown. When a source has not been collected recently, the number is a subtotal and is labeled as such.
- **Unallocated** GPUs on a cluster are node capacity minus allocation. Maintenance, reservations or QoS limits can still prevent you from using them.
- **QoS limits** are what the scheduler shows for your login. Limits alone do not prove access. The planner shows currently verified association grants by default and separates unverified or unassociated choices. Limits of different QoS do not add up.
- **Utilization** of cloud instances is an instant reading of the whole host. Inside a container it can reflect the host machine.
- **History** comes from successful collections only; periods without data stay empty.
- **Prices** are estimates from known hourly prices, not bills. Currencies are never added together.
