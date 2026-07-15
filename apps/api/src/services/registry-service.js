export function createRegistryService({ sharedFraudRegistryRepository = null } = {}) {
  return {
    hasMethod(name) {
      return Boolean(sharedFraudRegistryRepository && typeof sharedFraudRegistryRepository[name] === "function");
    },

    async searchRegistry({ subjectToken, fraudSubjectType = null }) {
      return sharedFraudRegistryRepository.searchRegistry({
        subjectToken,
        fraudSubjectType,
      });
    },

    async getRegistryHistory(subjectToken) {
      return sharedFraudRegistryRepository.getRegistryHistory(subjectToken);
    },

    async getRegistryRecordById(registryEntryId) {
      return sharedFraudRegistryRepository.getRegistryRecordById(registryEntryId);
    },
  };
}
