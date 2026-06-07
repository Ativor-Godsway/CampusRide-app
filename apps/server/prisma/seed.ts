import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const zones = [
  { name: "Main Gate",                      quadrant: "SOUTH",   latitude: 5.6502, longitude: -0.1862 },
  { name: "Legon Hall",                     quadrant: "CENTRAL", latitude: 5.6523, longitude: -0.1871 },
  { name: "Commonwealth Hall",              quadrant: "CENTRAL", latitude: 5.6518, longitude: -0.1855 },
  { name: "Volta Hall",                     quadrant: "NORTH",   latitude: 5.6545, longitude: -0.1878 },
  { name: "Akuafo Hall",                    quadrant: "CENTRAL", latitude: 5.6531, longitude: -0.1863 },
  { name: "Mensah Sarbah Hall",             quadrant: "EAST",    latitude: 5.6528, longitude: -0.1843 },
  { name: "ISH (International Students Hostel)", quadrant: "WEST", latitude: 5.6519, longitude: -0.1895 },
  { name: "School of Business",             quadrant: "SOUTH",   latitude: 5.6508, longitude: -0.1879 },
  { name: "Great Hall",                     quadrant: "CENTRAL", latitude: 5.6535, longitude: -0.1869 },
  { name: "Balme Library",                  quadrant: "CENTRAL", latitude: 5.6533, longitude: -0.1874 },
  { name: "Pentagon Hostel",                quadrant: "NORTH",   latitude: 5.6551, longitude: -0.1860 },
  { name: "Medical School (UGMS)",          quadrant: "EAST",    latitude: 5.6524, longitude: -0.1830 },
  { name: "Sports Stadium",                 quadrant: "WEST",    latitude: 5.6514, longitude: -0.1900 },
  { name: "Botanical Gardens Gate",         quadrant: "NORTH",   latitude: 5.6562, longitude: -0.1870 },
  { name: "Accra Mall Junction",            quadrant: "SOUTH",   latitude: 5.6490, longitude: -0.1856 },
];

async function main() {
  const existing = await prisma.zone.count();
  if (existing > 0) {
    console.log(`Zones already seeded (${existing} found). Skipping.`);
    return;
  }

  await prisma.zone.createMany({ data: zones });
  console.log(`Seeded ${zones.length} zones.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
