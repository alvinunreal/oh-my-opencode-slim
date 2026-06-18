import { defineConfig, tierPresets } from 'sponsorkit';

export default defineConfig({
  github: {
    login: 'alvinunreal',
    type: 'user',
  },
  width: 800,
  formats: ['svg'],
  tiers: [
    {
      title: 'Past Sponsors',
      monthlyDollars: -1,
      preset: tierPresets.xs,
    },
    {
      title: 'Explorers',
      monthlyDollars: 5,
      preset: tierPresets.base,
    },
    {
      title: 'Librarians',
      monthlyDollars: 15,
      preset: tierPresets.base,
    },
    {
      title: 'Fixers',
      monthlyDollars: 25,
      preset: tierPresets.medium,
    },
    {
      title: 'Designers',
      monthlyDollars: 50,
      preset: tierPresets.medium,
    },
    {
      title: 'Oracles',
      monthlyDollars: 100,
      preset: tierPresets.large,
    },
    {
      title: 'Orchestrators',
      monthlyDollars: 250,
      preset: tierPresets.xl,
    },
    {
      title: 'Council',
      monthlyDollars: 500,
      preset: tierPresets.xl,
    },
    {
      title: 'Pantheon',
      monthlyDollars: 1500,
      preset: tierPresets.xl,
    },
    {
      title: 'Divine Beings',
      monthlyDollars: 3000,
      preset: tierPresets.xl,
    },
  ],
});
